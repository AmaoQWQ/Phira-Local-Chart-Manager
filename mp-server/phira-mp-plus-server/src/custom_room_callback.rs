//! 托管房事件回调。
//!
//! 房间 actor 只负责提交状态；网络请求始终在独立受监督任务中执行，
//! 因此回调超时或下游故障不会阻塞或破坏房间状态机。

use crate::managed_rooms::CustomRoomEvent;
use crate::server::PlusServerState;
use std::sync::Arc;
use std::time::Duration;

const ATTEMPT_TIMEOUT: Duration = Duration::from_millis(1500);
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(500)];

pub fn emit(state: &Arc<PlusServerState>, event: CustomRoomEvent) {
    let Some(url) = state
        .config
        .custom_room_event_callback_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    let token = state.config.admin_token.trim().to_string();
    if token.is_empty() {
        return;
    }
    let event_name = serde_json::to_value(&event)
        .ok()
        .and_then(|value| {
            value
                .get("event")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "UNKNOWN".to_string());
    spawn_request(
        url,
        token,
        event_name,
        serde_json::to_value(event).unwrap_or_default(),
    );
}

/// 按给定顺序发送一组事件。用于 timeout -> cancelled 这类必须保持先后关系的回调。
pub fn emit_many(state: &Arc<PlusServerState>, events: Vec<CustomRoomEvent>) {
    let Some(url) = state
        .config
        .custom_room_event_callback_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    let token = state.config.admin_token.trim().to_string();
    if token.is_empty() {
        return;
    }
    let payloads = events
        .into_iter()
        .map(|event| {
            let value = serde_json::to_value(event).unwrap_or_default();
            let name = value
                .get("event")
                .and_then(|value| value.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            (name, value)
        })
        .collect();
    spawn_requests(url, token, payloads);
}

pub fn emit_contest_result(state: &Arc<PlusServerState>, payload: serde_json::Value) {
    let Some(url) = state
        .config
        .contest_result_callback_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    let token = state.config.admin_token.trim().to_string();
    if token.is_empty() {
        return;
    }
    spawn_request(url, token, "CONTEST_RESULT".to_string(), payload);
}

fn spawn_request(url: String, token: String, event_name: String, payload: serde_json::Value) {
    spawn_requests(url, token, vec![(event_name, payload)]);
}

fn spawn_requests(url: String, token: String, payloads: Vec<(String, serde_json::Value)>) {
    let task_name = payloads
        .first()
        .map(|(name, _)| name.as_str())
        .unwrap_or("EMPTY")
        .to_string();
    crate::supervisor_actor::spawn_named(format!("custom-room-callback-{task_name}"), async move {
        let client = match reqwest::Client::builder().timeout(ATTEMPT_TIMEOUT).build() {
            Ok(client) => client,
            Err(error) => {
                tracing::error!(%error, event = %task_name, "创建托管房回调客户端失败");
                return;
            }
        };
        for (event_name, payload) in payloads {
            let delivered = deliver(&client, &url, &token, &event_name, &payload).await;
            if !delivered {
                tracing::error!(event = %event_name, "托管房事件回调三次尝试均失败，房间状态不受影响");
            }
        }
    });
}

async fn deliver(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    event_name: &str,
    payload: &serde_json::Value,
) -> bool {
    for attempt in 0..3usize {
        let result = client
            .post(url)
            .header("x-tphira-token", token)
            .json(payload)
            .send()
            .await;
        match result {
            Ok(response) if response.status().is_success() => return true,
            Ok(response) => tracing::warn!(
                event = %event_name,
                attempt = attempt + 1,
                status = %response.status(),
                "托管房事件回调返回非成功状态"
            ),
            Err(error) => tracing::warn!(
                event = %event_name,
                attempt = attempt + 1,
                %error,
                "托管房事件回调失败"
            ),
        }
        if let Some(delay) = RETRY_DELAYS.get(attempt) {
            tokio::time::sleep(*delay).await;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn retry_contract_is_stable() {
        assert_eq!(ATTEMPT_TIMEOUT, Duration::from_millis(1500));
        assert_eq!(
            RETRY_DELAYS,
            [Duration::from_millis(250), Duration::from_millis(500)]
        );
    }

    #[tokio::test]
    async fn failed_callback_uses_token_and_stops_after_three_attempts() {
        #[derive(Clone)]
        struct TestState {
            calls: Arc<AtomicUsize>,
            token_seen: Arc<AtomicUsize>,
        }

        async fn fail(State(state): State<TestState>, headers: HeaderMap) -> StatusCode {
            state.calls.fetch_add(1, Ordering::SeqCst);
            if headers
                .get("x-tphira-token")
                .and_then(|value| value.to_str().ok())
                == Some("callback-secret")
            {
                state.token_seen.fetch_add(1, Ordering::SeqCst);
            }
            StatusCode::INTERNAL_SERVER_ERROR
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let token_seen = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/", post(fail)).with_state(TestState {
            calls: Arc::clone(&calls),
            token_seen: Arc::clone(&token_seen),
        });
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::builder()
            .timeout(ATTEMPT_TIMEOUT)
            .build()
            .unwrap();
        let delivered = deliver(
            &client,
            &format!("http://{address}/"),
            "callback-secret",
            "TEST",
            &serde_json::json!({"event": "TEST"}),
        )
        .await;
        server.abort();

        assert!(!delivered);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(token_seen.load(Ordering::SeqCst), 3);
    }
}
