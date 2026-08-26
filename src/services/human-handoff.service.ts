import crypto from 'crypto';
import { db } from '../database/db';

export class HumanHandoffService {
  public static readonly DEFAULT_STANDBY_HOURS = 12;

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

  public static handleOutboundEcho(storeId: number, recipientId: string, messageId: string, text: string): { automated: boolean; standbyUntil?: string } {
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
    `).run(`+${this.DEFAULT_STANDBY_HOURS} hours`, storeId, externalUserId);

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
}
