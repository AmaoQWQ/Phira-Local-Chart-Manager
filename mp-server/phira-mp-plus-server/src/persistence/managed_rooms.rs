use crate::db::DbManager;
use crate::managed_rooms::{ManagedRoomDefinition, ManagedRoomKind};

impl DbManager {
    pub async fn load_hosted_room_definitions(&self) -> anyhow::Result<Vec<ManagedRoomDefinition>> {
        let DbManager::Pg(pool) = self;
        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT definition FROM mp_managed_rooms WHERE kind = 'HOSTED' AND deleted = FALSE ORDER BY room_id",
        )
        .fetch_all(pool)
        .await?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            match serde_json::from_value::<ManagedRoomDefinition>(row) {
                Ok(definition) => result.push(definition),
                Err(error) => tracing::error!(%error, "忽略无法解析的托管房持久化记录"),
            }
        }
        Ok(result)
    }

    pub async fn upsert_hosted_room_definition(
        &self,
        definition: &ManagedRoomDefinition,
    ) -> anyhow::Result<()> {
        if definition.kind != ManagedRoomKind::Hosted {
            anyhow::bail!("only hosted rooms are restart-persistent");
        }
        let DbManager::Pg(pool) = self;
        let payload = serde_json::to_value(definition)?;
        sqlx::query(
            "INSERT INTO mp_managed_rooms (room_id, kind, definition, deleted, updated_at) \
             VALUES ($1, 'HOSTED', $2, FALSE, $3) \
             ON CONFLICT (room_id) DO UPDATE SET kind = EXCLUDED.kind, definition = EXCLUDED.definition, \
             deleted = FALSE, updated_at = EXCLUDED.updated_at",
        )
        .bind(&definition.room_id)
        .bind(payload)
        .bind(crate::db::now_ms())
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete_hosted_room_definition(&self, room_id: &str) -> anyhow::Result<()> {
        let DbManager::Pg(pool) = self;
        sqlx::query(
            "UPDATE mp_managed_rooms SET deleted = TRUE, updated_at = $2 WHERE room_id = $1",
        )
        .bind(room_id)
        .bind(crate::db::now_ms())
        .execute(pool)
        .await?;
        Ok(())
    }
}
