//! 管理房间的运行时编排。

use crate::managed_rooms::{ChartMode, CustomRoomEvent, ManagedRoomDefinition, ManagedRoomKind};
use crate::server::PlusServerState;
use phira_mp_common::StrippedRoomState;
use rand::RngExt;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOutcome {
    Created,
    Existing,
}

pub async fn restore_hosted_rooms(state: &Arc<PlusServerState>) -> anyhow::Result<()> {
    let definitions = state.db_manager.load_hosted_room_definitions().await?;
    for raw in definitions {
        let persisted_room_id = raw.room_id.clone();
        let definition = match raw.validate_and_normalize() {
            Ok(definition) if definition.is_hosted() => definition,
            Ok(_) => continue,
            Err(error) => {
                tracing::error!(room = %persisted_room_id, %error, "忽略非法托管房持久化记录");
                continue;
            }
        };
        if state
            .rooms
            .read()
            .await
            .keys()
            .any(|room_id| room_id.to_string() == definition.room_id)
        {
            tracing::warn!(room = %definition.room_id, "托管房恢复时发现同名运行时房间，跳过恢复");
            continue;
        }
        if let Err(error) = install_definition(state, definition.clone()).await {
            tracing::error!(room = %definition.room_id, %error, "恢复托管房失败");
        } else {
            tracing::info!(room = %definition.room_id, "已恢复托管房");
        }
    }
    Ok(())
}

pub async fn create(
    state: &Arc<PlusServerState>,
    definition: ManagedRoomDefinition,
) -> Result<CreateOutcome, String> {
    let definition = definition.validate_and_normalize()?;
    let _gate = state.managed_room_ops.lock().await;

    if let Some(existing) = state
        .managed_rooms
        .read()
        .await
        .get(&definition.room_id)
        .cloned()
    {
        return if existing.same_configuration(&definition) {
            Ok(CreateOutcome::Existing)
        } else {
            Err("room-id-occupied".to_string())
        };
    }
    let room_exists = state
        .rooms
        .read()
        .await
        .keys()
        .any(|id| id.to_string() == definition.room_id);
    if room_exists {
        return Err("room-id-occupied".to_string());
    }
    if let Some(limit) = state.config.max_rooms {
        if state.rooms.read().await.len() >= limit {
            return Err("rooms-limit-reached".to_string());
        }
    }

    install_definition(state, definition.clone()).await?;
    if definition.is_hosted() {
        if let Err(error) = state
            .db_manager
            .upsert_hosted_room_definition(&definition)
            .await
        {
            let _ = remove_runtime_room(state, &definition.room_id).await;
            return Err(format!("persist-hosted-room-failed: {error}"));
        }
    } else if let Some(expires_at) = definition.expires_at {
        schedule_reserved_expiry(state, &definition.room_id, expires_at);
    }
    Ok(CreateOutcome::Created)
}

async fn install_definition(
    state: &Arc<PlusServerState>,
    mut definition: ManagedRoomDefinition,
) -> Result<(), String> {
    if definition.chart_mode == ChartMode::PoolRandom && definition.chart.is_none() {
        definition.chart = choose_pool_chart(&definition);
    }
    state
        .create_empty_room_with_capacity(
            &definition.room_id,
            None,
            definition.kind == ManagedRoomKind::Hosted,
            definition.max_users,
        )
        .await?;

    let install = async {
        if definition.kind == ManagedRoomKind::Reserved {
            state
                .room_commands
                .set_tournament(state, &definition.room_id, true)
                .await?;
        }
        if let Some(chart) = &definition.chart {
            state
                .room_commands
                .set_chart(
                    state,
                    &definition.room_id,
                    chart.id,
                    &chart.name,
                    0,
                    None,
                    None,
                )
                .await?;
        }
        state
            .room_commands
            .set_host(state, &definition.room_id, definition.host_id)
            .await?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = install {
        let _ = remove_runtime_room(state, &definition.room_id).await;
        return Err(error);
    }
    state
        .managed_rooms
        .write()
        .await
        .insert(definition.room_id.clone(), definition);
    Ok(())
}

pub async fn update_hosted(
    state: &Arc<PlusServerState>,
    definition: ManagedRoomDefinition,
) -> Result<ManagedRoomDefinition, String> {
    let definition = definition.validate_and_normalize()?;
    if !definition.is_hosted() {
        return Err("room-not-found".to_string());
    }
    let _gate = state.managed_room_ops.lock().await;
    let previous = state
        .managed_rooms
        .read()
        .await
        .get(&definition.room_id)
        .cloned()
        .ok_or_else(|| "room-not-found".to_string())?;
    if !previous.is_hosted() {
        return Err("room-not-found".to_string());
    }
    let snapshot = state
        .room_snapshot(&definition.room_id)
        .ok_or_else(|| "room-not-found".to_string())?;
    if !matches!(snapshot.stripped, StrippedRoomState::SelectingChart) {
        return Err("hosted-room-busy".to_string());
    }
    if definition.max_users < snapshot.members.users.len() {
        return Err("hosted-room-capacity-below-users".to_string());
    }

    let old_host = previous.host_id;
    if previous.host_id != definition.host_id {
        state
            .room_commands
            .set_host(state, &definition.room_id, definition.host_id)
            .await?;
    }
    if previous.chart != definition.chart {
        if let Some(chart) = &definition.chart {
            state
                .room_commands
                .set_chart(
                    state,
                    &definition.room_id,
                    chart.id,
                    &chart.name,
                    0,
                    None,
                    None,
                )
                .await?;
        } else {
            state
                .room_commands
                .clear_chart(state, &definition.room_id)
                .await?;
        }
    }
    if previous.max_users != definition.max_users {
        state
            .room_commands
            .set_max_users(state, &definition.room_id, definition.max_users)
            .await?;
    }
    if let Err(error) = state
        .db_manager
        .upsert_hosted_room_definition(&definition)
        .await
    {
        // Actor 修改先于数据库提交，以便所有客户端看到单一排序点。若持久化失败，
        // 尽力恢复旧定义，避免本次 PATCH 返回失败后运行态却悄悄保留新配置。
        if previous.host_id != definition.host_id {
            let _ = state
                .room_commands
                .set_host(state, &definition.room_id, previous.host_id)
                .await;
        }
        if previous.chart != definition.chart {
            if let Some(chart) = &previous.chart {
                let _ = state
                    .room_commands
                    .set_chart(
                        state,
                        &definition.room_id,
                        chart.id,
                        &chart.name,
                        0,
                        None,
                        None,
                    )
                    .await;
            } else {
                let _ = state
                    .room_commands
                    .clear_chart(state, &definition.room_id)
                    .await;
            }
        }
        if previous.max_users != definition.max_users {
            let _ = state
                .room_commands
                .set_max_users(state, &definition.room_id, previous.max_users)
                .await;
        }
        return Err(format!("persist-hosted-room-failed: {error}"));
    }
    state
        .managed_rooms
        .write()
        .await
        .insert(definition.room_id.clone(), definition.clone());

    if old_host != definition.host_id {
        if let Some(host_id) = definition.host_id {
            crate::custom_room_callback::emit(
                state,
                CustomRoomEvent::HostChanged {
                    room_id: definition.room_id.clone(),
                    host_id,
                },
            );
        }
    }
    publish_managed_update(state, &definition.room_id, "updated");
    Ok(definition)
}

pub async fn persist_host_change(
    state: &Arc<PlusServerState>,
    room_id: &str,
    host_id: Option<i32>,
) {
    let _gate = state.managed_room_ops.lock().await;
    let definition = {
        let mut rooms = state.managed_rooms.write().await;
        let Some(definition) = rooms.get_mut(room_id) else {
            return;
        };
        if !definition.is_hosted() {
            return;
        }
        definition.host_id = host_id;
        definition.clone()
    };
    if let Err(error) = state
        .db_manager
        .upsert_hosted_room_definition(&definition)
        .await
    {
        tracing::error!(room = room_id, %error, "持久化托管房房主变更失败");
    }
    if let Some(host_id) = host_id {
        crate::custom_room_callback::emit(
            state,
            CustomRoomEvent::HostChanged {
                room_id: room_id.to_string(),
                host_id,
            },
        );
    }
    publish_managed_update(state, room_id, "host_changed");
}

pub async fn disband(state: &Arc<PlusServerState>, room_id: &str) -> Result<(), String> {
    let _gate = state.managed_room_ops.lock().await;
    let definition = state.managed_rooms.read().await.get(room_id).cloned();
    if !state
        .rooms
        .read()
        .await
        .keys()
        .any(|id| id.to_string() == room_id)
    {
        return Err("room-not-found".to_string());
    }
    let _ = state.room_commands.close_room(state, room_id).await;
    remove_runtime_room(state, room_id).await?;
    if definition
        .as_ref()
        .is_some_and(ManagedRoomDefinition::is_hosted)
    {
        state
            .db_manager
            .delete_hosted_room_definition(room_id)
            .await
            .map_err(|error| format!("delete-hosted-room-failed: {error}"))?;
    }
    publish_managed_update(state, room_id, "disbanded");
    Ok(())
}

async fn remove_runtime_room(state: &Arc<PlusServerState>, room_id: &str) -> Result<(), String> {
    let room_id_parsed: phira_mp_common::RoomId = room_id
        .to_string()
        .try_into()
        .map_err(|_| "invalid room_id".to_string())?;
    state.rooms.write().await.remove(&room_id_parsed);
    state.managed_rooms.write().await.remove(room_id);
    Ok(())
}

pub fn choose_pool_chart(
    definition: &ManagedRoomDefinition,
) -> Option<crate::managed_rooms::ManagedChart> {
    if definition.chart_pool.is_empty() {
        return None;
    }
    let index = rand::rng().random_range(0..definition.chart_pool.len());
    definition.chart_pool.get(index).cloned()
}

fn schedule_reserved_expiry(state: &Arc<PlusServerState>, room_id: &str, expires_at: i64) {
    let weak = Arc::downgrade(state);
    let room_id = room_id.to_string();
    crate::supervisor_actor::spawn_named(format!("reserved-room-expiry-{room_id}"), async move {
        let delay_ms = expires_at.saturating_sub(crate::db::now_ms()) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let Some(state) = weak.upgrade() else { return };
        let should_remove = state
            .room_snapshot(&room_id)
            .is_some_and(|snapshot| snapshot.members.is_empty());
        if should_remove {
            let _ = disband(&state, &room_id).await;
        }
    });
}

/// 预约房最后一名白名单玩家的 JoinRoom 响应确认写出后调用。
/// 500ms 仅用于让移动端安装房间状态，不影响 LeaveRoom。
pub fn schedule_reserved_autostart(state: &Arc<PlusServerState>, room_id: &str) {
    let weak = Arc::downgrade(state);
    let room_id = room_id.to_string();
    crate::supervisor_actor::spawn_named(format!("reserved-room-start-{room_id}"), async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let Some(state) = weak.upgrade() else { return };
        let definition = state.managed_rooms.read().await.get(&room_id).cloned();
        let Some(definition) = definition.filter(|d| d.kind == ManagedRoomKind::Reserved) else {
            return;
        };
        let Some(snapshot) = state.room_snapshot(&room_id) else {
            return;
        };
        if !matches!(snapshot.stripped, StrippedRoomState::SelectingChart) {
            return;
        }
        let present: std::collections::HashSet<i32> = snapshot.members.users.into_iter().collect();
        if definition.whitelist.iter().all(|id| present.contains(id))
            && present.len() == definition.whitelist.len()
        {
            if let Err(error) = state
                .room_commands
                .enter_ready_phase(&state, &room_id)
                .await
            {
                tracing::warn!(room = %room_id, %error, "预约房自动进入准备阶段失败");
            }
        }
    });
}

pub fn schedule_reserved_postgame(state: &Arc<PlusServerState>, room_id: &str) {
    let weak = Arc::downgrade(state);
    let room_id = room_id.to_string();
    crate::supervisor_actor::spawn_named(format!("reserved-room-postgame-{room_id}"), async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let Some(state) = weak.upgrade() else { return };
        let is_reserved = state
            .managed_rooms
            .read()
            .await
            .get(&room_id)
            .is_some_and(|definition| definition.kind == ManagedRoomKind::Reserved);
        if is_reserved {
            if let Err(error) = disband(&state, &room_id).await {
                tracing::warn!(room = %room_id, %error, "预约房赛后 60 秒强制回收失败");
            }
        }
    });
}

pub fn advance_pool_after_round(state: &Arc<PlusServerState>, room_id: &str) {
    let weak = Arc::downgrade(state);
    let room_id = room_id.to_string();
    crate::supervisor_actor::spawn_named(format!("hosted-room-pool-next-{room_id}"), async move {
        let Some(state) = weak.upgrade() else { return };
        let _gate = state.managed_room_ops.lock().await;
        let mut definition = match state.managed_rooms.read().await.get(&room_id).cloned() {
            Some(definition)
                if definition.kind == ManagedRoomKind::Hosted
                    && definition.chart_mode == ChartMode::PoolRandom =>
            {
                definition
            }
            _ => return,
        };
        let Some(chart) = choose_pool_chart(&definition) else {
            return;
        };
        if let Err(error) = state
            .room_commands
            .set_chart(&state, &room_id, chart.id, &chart.name, 0, None, None)
            .await
        {
            tracing::error!(room = %room_id, %error, "POOL_RANDOM 选择下一张谱面失败");
            return;
        }
        definition.chart = Some(chart);
        state
            .managed_rooms
            .write()
            .await
            .insert(room_id.clone(), definition.clone());
        if let Err(error) = state
            .db_manager
            .upsert_hosted_room_definition(&definition)
            .await
        {
            tracing::error!(room = %room_id, %error, "持久化 POOL_RANDOM 当前谱面失败");
        }
        publish_managed_update(&state, &room_id, "chart_selected");
    });
}

pub fn publish_managed_update(state: &PlusServerState, room_id: &str, action: &str) {
    state.events.publish(crate::plugin_http::SseEvent::new(
        "managed_room_update",
        serde_json::json!({"roomId": room_id, "action": action}).to_string(),
    ));
}
