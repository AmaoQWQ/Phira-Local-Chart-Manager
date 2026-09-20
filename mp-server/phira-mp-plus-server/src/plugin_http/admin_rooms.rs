use super::HttpAppState;
use crate::managed_rooms::{ChartMode, ManagedChart, ManagedRoomDefinition, ManagedRoomKind};
use crate::managed_rooms_runtime::{self, CreateOutcome};
use axum::{
    extract::{Extension, Path},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use phira_mp_common::{Message, RoomId};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) fn router() -> Router {
    Router::new()
        .route("/admin/rooms", get(list_rooms))
        .route("/admin/rooms/precreate", post(precreate_room))
        .route("/admin/rooms/hosted", post(create_hosted_room))
        .route(
            "/admin/rooms/{room_id}/hosted",
            get(get_hosted_room).patch(patch_hosted_room),
        )
        .route("/admin/rooms/{room_id}/max_users", post(set_max_users))
        .route("/admin/rooms/{room_id}/disband", post(disband_room))
        .route("/admin/rooms/{room_id}/chat", post(room_chat))
        .route(
            "/admin/rooms/{room_id}/chart_pool",
            get(get_chart_pool).put(set_chart_pool),
        )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    json_response(
        status,
        json!({"ok": false, "error": code, "message": message}),
    )
}

fn authenticate(state: &HttpAppState, headers: &HeaderMap) -> Result<(), Response> {
    let expected = state.server_state.config.admin_token.as_bytes();
    if expected.is_empty() {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "admin-disabled",
            "管理员 API 未启用",
        ));
    }
    let supplied = headers
        .get("x-admin-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .as_bytes();
    let mut difference = expected.len() ^ supplied.len();
    for index in 0..expected.len().max(supplied.len()) {
        difference |= usize::from(
            expected.get(index).copied().unwrap_or(0) ^ supplied.get(index).copied().unwrap_or(0),
        );
    }
    if difference != 0 {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "管理员令牌无效",
        ));
    }
    Ok(())
}

fn state_name(state: phira_mp_common::StrippedRoomState) -> &'static str {
    match state {
        phira_mp_common::StrippedRoomState::SelectingChart => "SelectChart",
        phira_mp_common::StrippedRoomState::WaitingForReady => "WaitForReady",
        phira_mp_common::StrippedRoomState::Playing => "Playing",
    }
}

fn definition_json(
    definition: &ManagedRoomDefinition,
    snapshot: Option<&crate::room_actor::RoomSnapshot>,
) -> Value {
    let mut value = json!({
        "ok": true,
        "hosted": definition.kind == ManagedRoomKind::Hosted,
        "roomid": definition.room_id,
        "owner_id": definition.owner_id,
        "capacity": definition.max_users,
        "allowed_user_ids": definition.whitelist,
        "host_id": definition.host_id,
        "chart": definition.chart,
        "chart_mode": definition.chart_mode,
        "chart_pool": definition.chart_pool,
    });
    if let (Some(object), Some(snapshot)) = (value.as_object_mut(), snapshot) {
        object.insert("state".into(), json!(state_name(snapshot.stripped)));
        object.insert("users".into(), json!(snapshot.members.users));
        object.insert("monitors".into(), json!(snapshot.members.monitors));
    }
    value
}

async fn list_rooms(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let definitions = state.server_state.managed_rooms.read().await.clone();
    let rooms: Vec<Value> = definitions
        .values()
        .map(|definition| {
            let snapshot = state.server_state.room_snapshot(&definition.room_id);
            definition_json(definition, snapshot.as_ref())
        })
        .collect();
    json_response(
        StatusCode::OK,
        json!({"ok": true, "total_rooms": rooms.len(), "rooms": rooms}),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedRequest {
    room_id: String,
    #[serde(default)]
    owner_id: Option<i64>,
    allowed_user_ids: Vec<i32>,
    #[serde(default = "default_hosted_capacity")]
    max_users: usize,
    #[serde(default)]
    host_id: Option<i32>,
    #[serde(default)]
    chart: Option<ManagedChart>,
    #[serde(default)]
    chart_mode: ChartMode,
    #[serde(default)]
    chart_pool: Vec<ManagedChart>,
}

fn default_hosted_capacity() -> usize {
    64
}

async fn create_hosted_room(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Json(request): Json<HostedRequest>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let room_id = request.room_id.clone();
    let definition = ManagedRoomDefinition {
        room_id: request.room_id,
        kind: ManagedRoomKind::Hosted,
        owner_id: request.owner_id,
        max_users: request.max_users,
        whitelist: request.allowed_user_ids,
        host_id: request.host_id,
        chart: request.chart,
        chart_mode: request.chart_mode,
        chart_pool: request.chart_pool,
        expires_at: None,
    };
    match managed_rooms_runtime::create(&state.server_state, definition).await {
        Ok(outcome) => {
            let definition = state
                .server_state
                .managed_rooms
                .read()
                .await
                .get(&room_id)
                .cloned();
            let Some(definition) = definition else {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "room-create-failed",
                    "房间已创建但无法读取定义",
                );
            };
            let mut value = definition_json(&definition, None);
            value
                .as_object_mut()
                .unwrap()
                .insert("created".into(), json!(outcome == CreateOutcome::Created));
            json_response(
                if outcome == CreateOutcome::Created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                value,
            )
        }
        Err(error) => create_error_response(&error, "bad-hosted-room-request"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrecreateRequest {
    room_id: String,
    #[serde(default)]
    owner_id: Option<i64>,
    allowed_user_ids: Vec<i32>,
    chart: ManagedChart,
    #[serde(default = "default_precreate_expiry")]
    expires_in_seconds: u64,
}

fn default_precreate_expiry() -> u64 {
    1800
}

async fn precreate_room(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Json(request): Json<PrecreateRequest>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    if !(30..=86_400).contains(&request.expires_in_seconds) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad-precreate-request",
            "预约房过期时间必须在 30 至 86400 秒之间",
        );
    }
    let mut whitelist = request.allowed_user_ids;
    whitelist.sort_unstable();
    whitelist.dedup();
    let room_id = request.room_id.clone();
    let chart = request.chart.clone();
    let definition = ManagedRoomDefinition {
        room_id: request.room_id,
        kind: ManagedRoomKind::Reserved,
        owner_id: request.owner_id,
        max_users: whitelist.len(),
        whitelist: whitelist.clone(),
        host_id: None,
        chart: Some(request.chart),
        chart_mode: ChartMode::HostSelect,
        chart_pool: vec![],
        expires_at: Some(crate::db::now_ms() + request.expires_in_seconds as i64 * 1000),
    };
    match managed_rooms_runtime::create(&state.server_state, definition).await {
        Ok(outcome) => {
            let definition = state
                .server_state
                .managed_rooms
                .read()
                .await
                .get(&room_id)
                .cloned()
                .unwrap();
            json_response(
                if outcome == CreateOutcome::Created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                json!({
                    "ok": true,
                    "created": outcome == CreateOutcome::Created,
                    "roomid": room_id,
                    "owner_id": definition.owner_id,
                    "allowed_user_ids": whitelist,
                    "chart": chart,
                    "expires_at": definition.expires_at,
                }),
            )
        }
        Err(error) => create_error_response(&error, "bad-precreate-request"),
    }
}

fn create_error_response(error: &str, validation_code: &str) -> Response {
    match error {
        "room-id-occupied" => api_error(StatusCode::CONFLICT, error, "房间 ID 已被不同配置占用"),
        "rooms-limit-reached" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            error,
            "服务器房间数量已达到上限",
        ),
        _ => api_error(StatusCode::BAD_REQUEST, validation_code, error),
    }
}

async fn get_hosted_room(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let definition = state
        .server_state
        .managed_rooms
        .read()
        .await
        .get(&room_id)
        .cloned();
    let Some(definition) = definition.filter(ManagedRoomDefinition::is_hosted) else {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到托管房");
    };
    let snapshot = state.server_state.room_snapshot(&room_id);
    json_response(
        StatusCode::OK,
        definition_json(&definition, snapshot.as_ref()),
    )
}

async fn patch_hosted_room(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let Some(mut definition) = state
        .server_state
        .managed_rooms
        .read()
        .await
        .get(&room_id)
        .cloned()
    else {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到托管房");
    };
    if !definition.is_hosted() {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到托管房");
    }
    let Some(object) = body.as_object() else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad-hosted-room-request",
            "请求体必须是对象",
        );
    };
    if let Some(value) = object.get("maxUsers") {
        definition.max_users = value.as_u64().unwrap_or_default() as usize;
    }
    if let Some(value) = object.get("allowedUserIds") {
        definition.whitelist = serde_json::from_value(value.clone()).unwrap_or_default();
    }
    if let Some(value) = object.get("hostId") {
        definition.host_id = if value.is_null() {
            None
        } else {
            value.as_i64().map(|id| id as i32)
        };
    }
    if let Some(value) = object.get("chart") {
        definition.chart = if value.is_null() {
            None
        } else {
            match serde_json::from_value(value.clone()) {
                Ok(chart) => Some(chart),
                Err(_) => {
                    return api_error(
                        StatusCode::BAD_REQUEST,
                        "bad-hosted-room-request",
                        "谱面字段无效",
                    )
                }
            }
        };
    }
    if let Some(value) = object.get("chartMode") {
        definition.chart_mode = match serde_json::from_value(value.clone()) {
            Ok(mode) => mode,
            Err(_) => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "bad-hosted-room-request",
                    "选谱模式无效",
                )
            }
        };
    }
    if let Some(value) = object.get("chartPool") {
        definition.chart_pool = match serde_json::from_value(value.clone()) {
            Ok(pool) => pool,
            Err(_) => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "bad-hosted-room-request",
                    "谱池字段无效",
                )
            }
        };
    }
    match managed_rooms_runtime::update_hosted(&state.server_state, definition).await {
        Ok(definition) => json_response(StatusCode::OK, definition_json(&definition, None)),
        Err(error) => update_error_response(&error),
    }
}

fn update_error_response(error: &str) -> Response {
    match error {
        "room-not-found" => api_error(StatusCode::NOT_FOUND, error, "未找到托管房"),
        "hosted-room-busy" | "hosted-room-capacity-below-users" => {
            api_error(StatusCode::CONFLICT, error, "房间当前状态不允许该修改")
        }
        _ => api_error(StatusCode::BAD_REQUEST, "bad-hosted-room-request", error),
    }
}

async fn set_max_users(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let max_users = body
        .get("maxUsers")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    if !(1..=crate::managed_rooms::MAX_MANAGED_ROOM_USERS).contains(&max_users) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad-max-users",
            "房间容量必须在 1 至 64 之间",
        );
    }
    let definition = state
        .server_state
        .managed_rooms
        .read()
        .await
        .get(&room_id)
        .cloned();
    if let Some(mut definition) = definition {
        if definition.is_hosted() {
            definition.max_users = max_users;
            return match managed_rooms_runtime::update_hosted(&state.server_state, definition).await
            {
                Ok(_) => json_response(
                    StatusCode::OK,
                    json!({"ok": true, "roomid": room_id, "max_users": max_users}),
                ),
                Err(error) => update_error_response(&error),
            };
        }
        if max_users < definition.whitelist.len() {
            return api_error(
                StatusCode::CONFLICT,
                "hosted-room-capacity-below-users",
                "容量不能低于白名单人数",
            );
        }
        definition.max_users = max_users;
        state
            .server_state
            .managed_rooms
            .write()
            .await
            .insert(room_id.clone(), definition);
    }
    if state.server_state.room_snapshot(&room_id).is_none() {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到房间");
    }
    match state
        .server_state
        .room_commands
        .set_max_users(&state.server_state, &room_id, max_users)
        .await
    {
        Ok(_) => json_response(
            StatusCode::OK,
            json!({"ok": true, "roomid": room_id, "max_users": max_users}),
        ),
        Err(error) if error.contains("below current users") => api_error(
            StatusCode::CONFLICT,
            "hosted-room-capacity-below-users",
            "容量不能低于当前玩家人数",
        ),
        Err(error) => api_error(StatusCode::BAD_REQUEST, "bad-max-users", &error),
    }
}

async fn disband_room(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    match managed_rooms_runtime::disband(&state.server_state, &room_id).await {
        Ok(()) => json_response(StatusCode::OK, json!({"ok": true, "roomid": room_id})),
        Err(error) if error == "room-not-found" => {
            api_error(StatusCode::NOT_FOUND, &error, "未找到房间")
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "room-disband-failed",
            &error,
        ),
    }
}

async fn room_chat(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if message.is_empty() || message.chars().count() > 200 {
        return api_error(
            StatusCode::BAD_REQUEST,
            if message.is_empty() {
                "bad-message"
            } else {
                "message-too-long"
            },
            "消息必须为 1 至 200 个字符",
        );
    }
    let Ok(parsed): Result<RoomId, _> = room_id.clone().try_into() else {
        return api_error(StatusCode::BAD_REQUEST, "invalid-room-id", "房间 ID 无效");
    };
    let room = state.server_state.rooms.read().await.get(&parsed).cloned();
    let Some(room) = room else {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到房间");
    };
    room.send(Message::Chat {
        user: 0,
        content: message.to_string(),
    })
    .await;
    json_response(StatusCode::OK, json!({"ok": true}))
}

async fn get_chart_pool(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let definition = state
        .server_state
        .managed_rooms
        .read()
        .await
        .get(&room_id)
        .cloned();
    let Some(definition) = definition.filter(ManagedRoomDefinition::is_hosted) else {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到托管房");
    };
    json_response(
        StatusCode::OK,
        json!({"ok": true, "roomid": room_id, "charts": definition.chart_pool}),
    )
}

async fn set_chart_pool(
    Extension(state): Extension<Arc<HttpAppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers) {
        return response;
    }
    let Some(mut definition) = state
        .server_state
        .managed_rooms
        .read()
        .await
        .get(&room_id)
        .cloned()
    else {
        return api_error(StatusCode::NOT_FOUND, "room-not-found", "未找到托管房");
    };
    definition.chart_pool = match body
        .get("charts")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
    {
        Some(charts) => charts,
        None => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "bad-chart-pool",
                "charts 必须是谱面数组",
            )
        }
    };
    match managed_rooms_runtime::update_hosted(&state.server_state, definition).await {
        Ok(definition) => json_response(
            StatusCode::OK,
            json!({"ok": true, "roomid": room_id, "charts": definition.chart_pool}),
        ),
        Err(error) => update_error_response(&error),
    }
}
