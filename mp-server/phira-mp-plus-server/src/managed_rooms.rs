//! 通用管理房间模型。
//!
//! 这里没有 Phirank 的排位业务概念。`Reserved` 是一次性预约白名单房，
//! `Hosted` 是可跨多局、空房保留并在重启后恢复的托管房。

use phira_mp_common::RoomId;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_MANAGED_ROOM_USERS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedChart {
    pub id: i32,
    pub name: String,
}

impl ManagedChart {
    pub fn validate(&self) -> Result<(), String> {
        let name = self.name.trim();
        if self.id == 0 || name.is_empty() || name.chars().count() > 200 {
            return Err("谱面必须包含非零整数 ID 和 1 至 200 字符的名称".to_string());
        }
        Ok(())
    }

    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChartMode {
    HostSelect,
    PoolRandom,
}

impl Default for ChartMode {
    fn default() -> Self {
        Self::HostSelect
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRoomKind {
    Hosted,
    Reserved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRoomDefinition {
    pub room_id: String,
    pub kind: ManagedRoomKind,
    /// 独立网页管理端中的所有者。它与 Phira 协议房主相互独立。
    #[serde(default)]
    pub owner_id: Option<i64>,
    pub max_users: usize,
    pub whitelist: Vec<i32>,
    pub host_id: Option<i32>,
    pub chart: Option<ManagedChart>,
    #[serde(default)]
    pub chart_mode: ChartMode,
    #[serde(default)]
    pub chart_pool: Vec<ManagedChart>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

impl ManagedRoomDefinition {
    pub fn validate_and_normalize(mut self) -> Result<Self, String> {
        let _: RoomId = self
            .room_id
            .clone()
            .try_into()
            .map_err(|_| "房间 ID 只能包含字母、数字、-、_，且长度为 1 至 20".to_string())?;

        let minimum_capacity = if self.kind == ManagedRoomKind::Hosted {
            2
        } else {
            1
        };
        if !(minimum_capacity..=MAX_MANAGED_ROOM_USERS).contains(&self.max_users) {
            return Err(format!("房间容量必须在 {minimum_capacity} 至 64 之间"));
        }
        if self.owner_id.is_some_and(|owner| owner <= 0) {
            return Err("网页房间所有者必须是正整数用户 ID".to_string());
        }

        let mut seen = HashSet::new();
        self.whitelist.retain(|id| seen.insert(*id));
        self.whitelist.sort_unstable();
        if self.whitelist.len() > MAX_MANAGED_ROOM_USERS
            || self.whitelist.iter().any(|id| *id <= 0)
            || self.whitelist.len() > self.max_users
        {
            return Err(
                "白名单只能包含最多 64 个不重复的正整数用户 ID，且不能超过容量".to_string(),
            );
        }
        if self.kind == ManagedRoomKind::Reserved && self.whitelist.is_empty() {
            return Err("预约白名单房必须包含至少一名玩家".to_string());
        }
        if self
            .host_id
            .is_some_and(|host| {
                host <= 0 || (!self.whitelist.is_empty() && !self.whitelist.contains(&host))
            })
        {
            return Err("协议房主必须是正整数；设置白名单时房主必须在白名单中".to_string());
        }

        if let Some(chart) = self.chart.take() {
            chart.validate()?;
            self.chart = Some(chart.normalized());
        }

        let mut chart_ids = HashSet::new();
        let mut pool = Vec::with_capacity(self.chart_pool.len());
        for chart in self.chart_pool {
            chart.validate()?;
            let chart = chart.normalized();
            if chart_ids.insert(chart.id) {
                pool.push(chart);
            }
        }
        self.chart_pool = pool;
        self.chart_pool.sort_by_key(|chart| chart.id);

        if self.kind == ManagedRoomKind::Reserved {
            if self.chart.is_none() {
                return Err("预约白名单房必须指定谱面".to_string());
            }
            self.chart_mode = ChartMode::HostSelect;
            self.chart_pool.clear();
            if self.expires_at.is_none() {
                return Err("预约白名单房必须包含过期时间".to_string());
            }
        } else {
            self.expires_at = None;
            if self.chart_mode == ChartMode::PoolRandom && self.chart_pool.is_empty() {
                if let Some(chart) = self.chart.clone() {
                    // 与现有 Phirank 请求兼容：旧调用方只发送本轮 chart。
                    // 在独立部署中将其作为初始本地谱池，后续可通过管理 API 扩充。
                    self.chart_pool.push(chart);
                } else {
                    return Err("POOL_RANDOM 托管房必须配置至少一张本地谱池谱面".to_string());
                }
            }
        }
        Ok(self)
    }

    pub fn is_hosted(&self) -> bool {
        self.kind == ManagedRoomKind::Hosted
    }

    pub fn contains_user(&self, user_id: i32) -> bool {
        (self.kind == ManagedRoomKind::Hosted && self.whitelist.is_empty())
            || self.whitelist.contains(&user_id)
    }

    pub fn same_configuration(&self, other: &Self) -> bool {
        if self.kind == ManagedRoomKind::Reserved && other.kind == ManagedRoomKind::Reserved {
            let mut left = self.clone();
            let mut right = other.clone();
            left.expires_at = None;
            right.expires_at = None;
            left == right
        } else {
            self == other
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CustomRoomEvent {
    HostChanged {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "hostId")]
        host_id: i32,
    },
    RoundStarted {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "roundId")]
        round_id: String,
        #[serde(rename = "participantIds")]
        participant_ids: Vec<i32>,
        #[serde(rename = "spectatorIds")]
        spectator_ids: Vec<i32>,
        #[serde(rename = "inPhiraIds")]
        in_phira_ids: Vec<i32>,
        chart: ManagedChart,
    },
    RoundReadyTimeout {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "roundId")]
        round_id: String,
        #[serde(rename = "readyIds")]
        ready_ids: Vec<i32>,
    },
    RoundCompleted {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "roundId")]
        round_id: String,
        results: serde_json::Value,
        #[serde(rename = "abortedIds")]
        aborted_ids: Vec<i32>,
    },
    RoundCancelled {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "roundId")]
        round_id: String,
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_host_select_accepts_empty_chart_and_deduplicates_whitelist() {
        let room = ManagedRoomDefinition {
            room_id: "hosted-1".into(),
            kind: ManagedRoomKind::Hosted,
            owner_id: None,
            max_users: 4,
            whitelist: vec![1, 1, 2],
            host_id: Some(1),
            chart: None,
            chart_mode: ChartMode::HostSelect,
            chart_pool: vec![],
            expires_at: None,
        }
        .validate_and_normalize()
        .unwrap();
        assert_eq!(room.whitelist, vec![1, 2]);
        assert!(room.chart.is_none());
    }

    #[test]
    fn pool_random_requires_a_local_pool_for_standalone_use() {
        let error = ManagedRoomDefinition {
            room_id: "pool".into(),
            kind: ManagedRoomKind::Hosted,
            owner_id: None,
            max_users: 2,
            whitelist: vec![1, 2],
            host_id: Some(1),
            chart: None,
            chart_mode: ChartMode::PoolRandom,
            chart_pool: vec![],
            expires_at: None,
        }
        .validate_and_normalize()
        .unwrap_err();
        assert!(error.contains("谱池"));
    }

    #[test]
    fn private_negative_chart_ids_are_supported() {
        ManagedChart {
            id: -13,
            name: "私有谱面".into(),
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn reserved_room_accepts_supported_match_sizes() {
        for size in [2usize, 4, 6, 8] {
            let room = ManagedRoomDefinition {
                room_id: format!("reserved-{size}"),
                kind: ManagedRoomKind::Reserved,
                owner_id: None,
                max_users: size,
                whitelist: (1..=size as i32).collect(),
                host_id: None,
                chart: Some(ManagedChart {
                    id: 7,
                    name: "测试谱面".into(),
                }),
                chart_mode: ChartMode::HostSelect,
                chart_pool: vec![],
                expires_at: Some(1),
            };
            assert!(room.validate_and_normalize().is_ok(), "size={size}");
        }
    }

    #[test]
    fn host_must_be_whitelisted_and_capacity_cannot_be_too_small() {
        let base = ManagedRoomDefinition {
            room_id: "host-check".into(),
            kind: ManagedRoomKind::Hosted,
            owner_id: None,
            max_users: 2,
            whitelist: vec![1, 2],
            host_id: Some(3),
            chart: None,
            chart_mode: ChartMode::HostSelect,
            chart_pool: vec![],
            expires_at: None,
        };
        assert!(
            base.clone()
                .validate_and_normalize()
                .unwrap_err()
                .contains("房主")
        );
        assert!(
            ManagedRoomDefinition {
                max_users: 1,
                host_id: Some(1),
                ..base
            }
            .validate_and_normalize()
            .is_err()
        );
    }

    #[test]
    fn reserved_idempotency_ignores_only_renewed_expiry() {
        let first = ManagedRoomDefinition {
            room_id: "once".into(),
            kind: ManagedRoomKind::Reserved,
            owner_id: None,
            max_users: 2,
            whitelist: vec![1, 2],
            host_id: None,
            chart: Some(ManagedChart {
                id: 8,
                name: "A".into(),
            }),
            chart_mode: ChartMode::HostSelect,
            chart_pool: vec![],
            expires_at: Some(100),
        };
        let mut retried = first.clone();
        retried.expires_at = Some(200);
        assert!(first.same_configuration(&retried));
        retried.chart = Some(ManagedChart {
            id: 9,
            name: "B".into(),
        });
        assert!(!first.same_configuration(&retried));
    }

    #[test]
    fn hosted_empty_whitelist_is_public_and_may_have_a_host() {
        let room = ManagedRoomDefinition {
            room_id: "public-room".into(),
            kind: ManagedRoomKind::Hosted,
            owner_id: Some(7),
            max_users: 4,
            whitelist: vec![],
            host_id: Some(1001),
            chart: None,
            chart_mode: ChartMode::HostSelect,
            chart_pool: vec![],
            expires_at: None,
        }
        .validate_and_normalize()
        .unwrap();
        assert!(room.contains_user(1001));
        assert!(room.contains_user(987654));
    }

    #[test]
    fn reserved_room_still_requires_a_whitelist() {
        let error = ManagedRoomDefinition {
            room_id: "reserved-empty".into(),
            kind: ManagedRoomKind::Reserved,
            owner_id: Some(7),
            max_users: 2,
            whitelist: vec![],
            host_id: None,
            chart: Some(ManagedChart {
                id: 8,
                name: "测试谱面".into(),
            }),
            chart_mode: ChartMode::HostSelect,
            chart_pool: vec![],
            expires_at: Some(100),
        }
        .validate_and_normalize()
        .unwrap_err();
        assert!(error.contains("至少一名玩家"));
    }
}
