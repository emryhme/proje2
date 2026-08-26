import crypto from 'crypto';
import { db } from '../database/db';

export class HumanHandoffService {
  public static readonly DEFAULT_STANDBY_MINUTES = 60;

  public static getStoreConfig(storeId: number): { enabled: boolean; minutes: number } {
    const rows = db.prepare("SELECT key, value FROM settings WHERE store_id = ? AND key IN ('human_handoff_enabled', 'human_handoff_minutes')")
      .all(storeId) as Array<{ key: string; value: string }>;
    const settings = Object.fromEntries(rows.map(row => [row.key, String(row.value || '')]));
    const minutes = [15, 30, 60, 120].includes(Number(settings.human_handoff_minutes))
      ? Number(settings.human_handoff_minutes)
      : this.DEFAULT_STANDBY_MINUTES;
    return { enabled: settings.human_handoff_enabled !== '0', minutes };
  }

  private static textHash(text: string): string {
    return crypto.createHash('sha256').update(String(text || '').trim(), 'utf8').digest('hex');
  }

  public static beginAutomatedOutbound(storeId: number, recipientId: string, text: string): string {
    const trackingId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO automated_outbound_messages
        (tracking_id, store_id, recipient_id, text_hash, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))
    `).run(trackingId, storeId, String(recipientId), this.textHash(text));
    return trackingId;
  }

  public static completeAutomatedOutbound(trackingId: string, messageId: string): void {
    db.prepare('UPDATE automated_outbound_messages SET message_id = ? WHERE tracking_id = ?')
      .run(String(messageId || '').trim() || null, trackingId);
  }

  public static cancelAutomatedOutbound(trackingId: string): void {
    db.prepare('DELETE FROM automated_outbound_messages WHERE tracking_id = ?').run(trackingId);
  }

  public static handleOutboundEcho(storeId: number, recipientId: string, messageId: string, text: string): { automated: boolean; disabled?: boolean; standbyUntil?: string } {
    const cleanRecipientId = String(recipientId || '').trim();
    const cleanMessageId = String(messageId || '').trim();
    if (!cleanRecipientId) return { automated: false };

    db.prepare("DELETE FROM automated_outbound_messages WHERE expires_at <= datetime('now')").run();
    const automated = db.prepare(`
      SELECT tracking_id FROM automated_outbound_messages
      WHERE store_id = ? AND recipient_id = ? AND expires_at > datetime('now')
        AND ((message_id IS NOT NULL AND message_id = ?) OR text_hash = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(storeId, cleanRecipientId, cleanMessageId, this.textHash(text)) as { tracking_id: string } | undefined;
    if (automated) {
      db.prepare('DELETE FROM automated_outbound_messages WHERE tracking_id = ?').run(automated.tracking_id);
      return { automated: true };
    }

    const config = this.getStoreConfig(storeId);
    if (!config.enabled) return { automated: false, disabled: true };

    const externalUserId = `instagram:${cleanRecipientId}`;
    let conversation = db.prepare('SELECT id, standby_until FROM conversations WHERE store_id = ? AND external_user_id = ?')
      .get(storeId, externalUserId) as { id: number; standby_until?: string } | undefined;
    if (!conversation) {
      db.prepare("INSERT INTO conversations (store_id, external_user_id, channel) VALUES (?, ?, 'instagram')")
        .run(storeId, externalUserId);
    }
    db.prepare(`
      UPDATE conversations
      SET status = 'standby',
          standby_started_at = CURRENT_TIMESTAMP,
          standby_until = datetime('now', ?),
          standby_reason = 'owner_message'
      WHERE store_id = ? AND external_user_id = ?
    `).run(`+${config.minutes} minutes`, storeId, externalUserId);

    conversation = db.prepare('SELECT id, standby_until FROM conversations WHERE store_id = ? AND external_user_id = ?')
      .get(storeId, externalUserId) as { id: number; standby_until: string } | undefined;
    const cleanText = String(text || '').trim();
    if (conversation && cleanText) {
      db.prepare("INSERT INTO messages (conversation_id, sender_type, text) VALUES (?, 'owner', ?)")
        .run(conversation.id, cleanText.slice(0, 4_000));
    }
    return { automated: false, standbyUntil: conversation?.standby_until };
  }

  public static isConversationOnStandby(storeId: number, recipientId: string): boolean {
    if (!this.getStoreConfig(storeId).enabled) return false;
    const externalUserId = `instagram:${String(recipientId || '').trim()}`;
    const conversation = db.prepare(`
      SELECT id, standby_until FROM conversations
      WHERE store_id = ? AND external_user_id = ?
    `).get(storeId, externalUserId) as { id: number; standby_until?: string } | undefined;
    if (!conversation?.standby_until) return false;

    const active = (db.prepare("SELECT datetime(?) > datetime('now') AS active").get(conversation.standby_until) as { active: number }).active === 1;
    if (!active) {
      db.prepare(`
        UPDATE conversations
        SET status = 'active', standby_until = NULL, standby_reason = '', standby_started_at = NULL
        WHERE id = ?
      `).run(conversation.id);
    }
    return active;
  }

  public static listActiveStandbyConversations(storeId: number): Array<{
    id: number; externalUserId: string; standbyUntil: string; standbyStartedAt: string; lastMessage: string; lastMessageAt: string;
  }> {
    db.prepare(`
      UPDATE conversations
      SET status = 'active', standby_until = NULL, standby_reason = '', standby_started_at = NULL
      WHERE store_id = ? AND standby_until IS NOT NULL AND standby_until <= datetime('now')
    `).run(storeId);
    return db.prepare(`
      SELECT c.id,
             c.external_user_id AS externalUserId,
             c.standby_until AS standbyUntil,
             c.standby_started_at AS standbyStartedAt,
             COALESCE((SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1), '') AS lastMessage,
             COALESCE((SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1), c.created_at) AS lastMessageAt
      FROM conversations c
      WHERE c.store_id = ? AND c.status = 'standby' AND c.standby_until > datetime('now')
      ORDER BY c.standby_until DESC
    `).all(storeId) as any;
  }

  public static resumeConversation(storeId: number, conversationId: number): boolean {
    const result = db.prepare(`
      UPDATE conversations
      SET status = 'active', standby_until = NULL, standby_reason = '', standby_started_at = NULL
      WHERE id = ? AND store_id = ?
    `).run(conversationId, storeId);
    return result.changes > 0;
  }
}
