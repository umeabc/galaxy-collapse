/** SQLite 数据访问层：posts / drafts / queue / publications / media_cache。 */

export function createStore(db) {
  const now = () => Date.now();

  // ---------------------------------------------------------------- announcement sources

  function listAnnouncementSources() {
    return db.prepare("SELECT * FROM announcement_sources ORDER BY CASE key WHEN 'jp' THEN 0 WHEN 'global' THEN 1 WHEN 'cn' THEN 2 ELSE 9 END")
      .all()
      .map(row => ({ ...row, enabled: Boolean(row.enabled), lastSyncAt: row.last_sync_at, lastError: row.last_error, lastCount: row.last_count }));
  }

  function getAnnouncementSource(key) {
    const row = db.prepare('SELECT * FROM announcement_sources WHERE key = ?').get(String(key));
    return row ? { ...row, enabled: Boolean(row.enabled), lastSyncAt: row.last_sync_at, lastError: row.last_error, lastCount: row.last_count } : null;
  }

  function updateAnnouncementSource(key, patch = {}) {
    const current = getAnnouncementSource(key);
    if (!current) return null;
    db.prepare(`UPDATE announcement_sources SET enabled=@enabled, last_sync_at=@lastSyncAt,
      last_error=@lastError, last_count=@lastCount WHERE key=@key`).run({
      key: String(key),
      enabled: patch.enabled === undefined ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
      lastSyncAt: patch.lastSyncAt === undefined ? current.last_sync_at : patch.lastSyncAt,
      lastError: patch.lastError === undefined ? current.last_error : patch.lastError,
      lastCount: patch.lastCount === undefined ? current.last_count : patch.lastCount,
    });
    return getAnnouncementSource(key);
  }

  function listAnnouncementDrafts({ limit = 50 } = {}) {
    return db.prepare(`SELECT d.*, p.source_key, p.kind AS post_kind, p.url AS source_url,
        p.author AS source_author, p.published_at, p.blocks_json,
        pb.url AS publication_url, pb.content_id AS publication_content_id
      FROM drafts d
      JOIN posts p ON p.id = d.post_id
      LEFT JOIN publications pb ON pb.draft_id = d.id
      WHERE p.kind = 'announcement'
      ORDER BY d.id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))).map(row => ({
      ...hydrateDraft(row),
      publicationUrl: row.publication_url,
      publicationContentId: row.publication_content_id,
      publishedAt: row.published_at,
    }));
  }

  // ---------------------------------------------------------------- subscriptions

  function hydrateSubscription(row) {
    if (!row) return null;
    return {
      ...row,
      include_forwards: Boolean(row.include_forwards),
      enabled: Boolean(row.enabled),
      includeForwards: Boolean(row.include_forwards),
      subscribedAt: row.subscribed_at,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
    };
  }

  function listSubscriptions({ enabledOnly = false } = {}) {
    const where = enabledOnly ? 'WHERE enabled = 1' : '';
    return db.prepare(`SELECT * FROM subscriptions ${where} ORDER BY subscribed_at ASC, id ASC`)
      .all()
      .map(hydrateSubscription);
  }

  function getSubscription(id) {
    return hydrateSubscription(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id));
  }

  function findSubscription(mid, mode) {
    return hydrateSubscription(db.prepare('SELECT * FROM subscriptions WHERE mid = ? AND mode = ?').get(String(mid), String(mode)));
  }

  function addSubscription({ mid, name = '', mode = 'dynamic', includeForwards = true, enabled = true, subscribedAt = Date.now() }) {
    const existing = findSubscription(mid, mode);
    if (existing) return { created: false, subscription: existing };
    const timestamp = Date.now();
    const info = db.prepare(`INSERT INTO subscriptions(mid,name,mode,include_forwards,enabled,subscribed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      String(mid),
      String(name ?? ''),
      String(mode),
      includeForwards ? 1 : 0,
      enabled ? 1 : 0,
      Number(subscribedAt) || timestamp,
      timestamp,
      timestamp,
    );
    return { created: true, subscription: getSubscription(Number(info.lastInsertRowid)) };
  }

  function updateSubscription(id, patch = {}) {
    const current = getSubscription(id);
    if (!current) return null;
    db.prepare(`UPDATE subscriptions SET name=@name, include_forwards=@includeForwards, enabled=@enabled,
      last_sync_at=@lastSyncAt, last_error=@lastError, updated_at=@updatedAt WHERE id=@id`).run({
      id,
      name: patch.name === undefined ? current.name : String(patch.name),
      includeForwards: patch.includeForwards === undefined ? (current.include_forwards ? 1 : 0) : (patch.includeForwards ? 1 : 0),
      enabled: patch.enabled === undefined ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
      lastSyncAt: patch.lastSyncAt === undefined ? current.last_sync_at : patch.lastSyncAt,
      lastError: patch.lastError === undefined ? current.last_error : patch.lastError,
      updatedAt: Date.now(),
    });
    return getSubscription(id);
  }

  function deleteSubscription(id) {
    return db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id).changes > 0;
  }

  function touchSubscription(id, { lastSyncAt = Date.now(), lastError = null, name } = {}) {
    const current = getSubscription(id);
    if (!current) return null;
    return updateSubscription(id, {
      lastSyncAt,
      lastError,
      name: name === undefined ? current.name : name,
    });
  }

  // ---------------------------------------------------------------- posts

  function findPostByKey(sourceKey) {
    return db.prepare('SELECT * FROM posts WHERE source_key = ?').get(sourceKey) ?? null;
  }

  function upsertPost(post) {
    const existing = findPostByKey(post.sourceKey);
    const timestamp = now();
    if (existing) {
      db.prepare(`UPDATE posts SET title=@title, author=@author, author_mid=@authorMid,
        url=@url, published_at=@publishedAt, blocks_json=@blocksJson, markdown=@markdown,
        status=@status, error=NULL, updated_at=@updatedAt WHERE id=@id`).run({
        id: existing.id,
        title: post.title,
        author: post.author,
        authorMid: post.authorMid ?? '',
        url: post.url,
        publishedAt: post.publishedAt ?? null,
        blocksJson: JSON.stringify(post.blocks ?? []),
        markdown: post.markdown ?? '',
        status: post.status ?? existing.status,
        updatedAt: timestamp,
      });
      return { post: getPost(existing.id), created: false };
    }
    const info = db.prepare(`INSERT INTO posts(source_key, kind, title, author, author_mid, url, published_at,
      blocks_json, markdown, status, created_at, updated_at)
      VALUES(@sourceKey,@kind,@title,@author,@authorMid,@url,@publishedAt,@blocksJson,@markdown,@status,@createdAt,@updatedAt)`).run({
      sourceKey: post.sourceKey,
      kind: post.kind ?? 'dynamic',
      title: post.title ?? '',
      author: post.author ?? '',
      authorMid: post.authorMid ?? '',
      url: post.url ?? '',
      publishedAt: post.publishedAt ?? null,
      blocksJson: JSON.stringify(post.blocks ?? []),
      markdown: post.markdown ?? '',
      status: post.status ?? 'FETCHED',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { post: getPost(Number(info.lastInsertRowid)), created: true };
  }

  function getPost(id) {
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      blocks: safeParse(row.blocks_json, []),
      publishedAt: row.published_at,
    };
  }

  function setPostStatus(id, status, error = null) {
    db.prepare('UPDATE posts SET status=?, error=?, updated_at=? WHERE id=?').run(status, error, now(), id);
  }

  // ---------------------------------------------------------------- drafts

  function createDraft(input) {
    const timestamp = now();
    const info = db.prepare(`INSERT INTO drafts(post_id,title,markdown,summary,images_json,editor_type,type,tag,status,created_at,updated_at)
      VALUES(@postId,@title,@markdown,@summary,@imagesJson,@editorType,@type,@tag,@status,@createdAt,@updatedAt)`).run({
      postId: input.postId ?? null,
      title: input.title ?? '',
      markdown: input.markdown ?? '',
      summary: input.summary ?? '',
      imagesJson: JSON.stringify(input.images ?? []),
      editorType: input.editorType ?? 1,
      type: input.type ?? 4,
      tag: input.tag ?? '2',
      status: input.status ?? 'DRAFT',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return getDraft(Number(info.lastInsertRowid));
  }

  const DRAFT_SELECT = `SELECT d.*, p.url AS source_url, p.author AS source_author, p.kind AS source_kind,
      p.source_key AS source_key
    FROM drafts d LEFT JOIN posts p ON p.id = d.post_id`;

  function hydrateDraft(row) {
    if (!row) return null;
    return {
      ...row,
      images: safeParse(row.images_json, []),
      review: safeParse(row.review_json, null),
      editor_type: row.editor_type,
      sourceUrl: row.source_url,
      sourceAuthor: row.source_author,
      sourceKind: row.source_kind,
      sourceKey: row.source_key,
    };
  }

  function getDraft(id) {
    return hydrateDraft(db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).get(id));
  }

  function getDraftByPost(postId) {
    return hydrateDraft(db.prepare(`${DRAFT_SELECT} WHERE d.post_id = ?`).get(postId));
  }

  function listDrafts({ status = null, limit = 50, offset = 0 } = {}) {
    const where = status ? 'WHERE d.status = @status' : '';
    return db.prepare(`${DRAFT_SELECT} ${where} ORDER BY d.id DESC LIMIT @limit OFFSET @offset`)
      .all({ status, limit: Math.min(200, Math.max(1, limit)), offset: Math.max(0, offset) })
      .map(hydrateDraft);
  }

  function countDrafts() {
    return db.prepare('SELECT status, COUNT(*) AS count FROM drafts GROUP BY status').all();
  }

  function updateDraft(id, patch = {}) {
    const draft = getDraft(id);
    if (!draft) return null;
    const next = {
      title: patch.title ?? draft.title,
      markdown: patch.markdown ?? draft.markdown,
      summary: patch.summary ?? draft.summary,
      editorType: patch.editorType ?? draft.editor_type,
      type: patch.type ?? draft.type,
      tag: patch.tag ?? draft.tag,
    };
    db.prepare(`UPDATE drafts SET title=@title, markdown=@markdown, summary=@summary,
      editor_type=@editorType, type=@type, tag=@tag, updated_at=@updatedAt WHERE id=@id`).run({
      ...next,
      id,
      updatedAt: now(),
    });
    if (patch.images) {
      db.prepare('UPDATE drafts SET images_json=? WHERE id=?').run(JSON.stringify(patch.images), id);
    }
    return getDraft(id);
  }

  function setDraftStatus(id, status, { error = null, review = undefined } = {}) {
    if (review === undefined) {
      db.prepare('UPDATE drafts SET status=?, error=?, updated_at=? WHERE id=?').run(status, error, now(), id);
    } else {
      db.prepare('UPDATE drafts SET status=?, error=?, review_json=?, updated_at=? WHERE id=?')
        .run(status, error, review === null ? null : JSON.stringify(review), now(), id);
    }
  }

  // ---------------------------------------------------------------- queue

  function activeQueueItem(draftId) {
    return db.prepare("SELECT * FROM queue WHERE draft_id=? AND state IN ('QUEUED','PUBLISHING') ORDER BY id DESC LIMIT 1").get(draftId) ?? null;
  }

  function enqueue(draftId, { nextAttemptAt = 0 } = {}) {
    const existing = activeQueueItem(draftId);
    if (existing) return existing;
    const timestamp = now();
    const info = db.prepare(`INSERT INTO queue(draft_id,state,attempts,next_attempt_at,created_at,updated_at)
      VALUES(?, 'QUEUED', 0, ?, ?, ?)`).run(draftId, nextAttemptAt, timestamp, timestamp);
    return getQueueItem(Number(info.lastInsertRowid));
  }

  function getQueueItem(id) {
    return db.prepare(`SELECT q.*, d.title AS draft_title, d.status AS draft_status, p.url AS source_url
      FROM queue q JOIN drafts d ON d.id=q.draft_id LEFT JOIN posts p ON p.id=d.post_id WHERE q.id=?`).get(id) ?? null;
  }

  function listQueue({ state = null, limit = 100 } = {}) {
    const where = state ? 'WHERE q.state = @state' : '';
    return db.prepare(`SELECT q.*, d.title AS draft_title, d.status AS draft_status, p.url AS source_url
      FROM queue q JOIN drafts d ON d.id=q.draft_id LEFT JOIN posts p ON p.id=d.post_id
      ${where} ORDER BY q.id DESC LIMIT @limit`).all({ state, limit: Math.min(300, Math.max(1, limit)) });
  }

  function dueQueueItem(timestamp) {
    return db.prepare(`SELECT q.*, d.title AS draft_title, d.status AS draft_status
      FROM queue q JOIN drafts d ON d.id=q.draft_id
      WHERE q.state='QUEUED' AND q.next_attempt_at <= ? ORDER BY q.id ASC LIMIT 1`).get(timestamp) ?? null;
  }

  function claimQueueItem(id) {
    return db.prepare("UPDATE queue SET state='PUBLISHING', updated_at=? WHERE id=? AND state='QUEUED'").run(now(), id).changes === 1;
  }

  function updateQueueItem(id, patch = {}) {
    const item = db.prepare('SELECT * FROM queue WHERE id=?').get(id);
    if (!item) return null;
    db.prepare(`UPDATE queue SET state=@state, attempts=@attempts, next_attempt_at=@nextAttemptAt,
      last_error=@lastError, content_id=@contentId, published_at=@publishedAt, published_day=@publishedDay,
      updated_at=@updatedAt WHERE id=@id`).run({
      id,
      state: patch.state ?? item.state,
      attempts: patch.attempts ?? item.attempts,
      nextAttemptAt: patch.nextAttemptAt ?? item.next_attempt_at,
      lastError: patch.lastError === undefined ? item.last_error : patch.lastError,
      contentId: patch.contentId ?? item.content_id,
      publishedAt: patch.publishedAt === undefined ? item.published_at : patch.publishedAt,
      publishedDay: patch.publishedDay === undefined ? item.published_day : patch.publishedDay,
      updatedAt: now(),
    });
    return getQueueItem(id);
  }

  function lastPublishedAt() {
    return db.prepare("SELECT MAX(published_at) AS at FROM queue WHERE state='PUBLISHED'").get()?.at ?? null;
  }

  function countPublishedOn(day) {
    return db.prepare("SELECT COUNT(*) AS count FROM queue WHERE state='PUBLISHED' AND published_day=?").get(day)?.count ?? 0;
  }

  // ---------------------------------------------------------------- publications

  function recordPublication({ draftId, contentId, url, state = 'PUBLISHED' }) {
    const timestamp = now();
    db.prepare(`INSERT INTO publications(draft_id,content_id,url,state,last_pushed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(content_id) DO UPDATE SET draft_id=excluded.draft_id, url=excluded.url, state=excluded.state,
        last_pushed_at=excluded.last_pushed_at, updated_at=excluded.updated_at`)
      .run(draftId, String(contentId), url ?? '', state, timestamp, timestamp, timestamp);
    return getPublicationByContent(contentId);
  }

  function getPublicationByContent(contentId) {
    return db.prepare('SELECT * FROM publications WHERE content_id=?').get(String(contentId)) ?? null;
  }

  function getPublicationById(id) {
    return db.prepare('SELECT * FROM publications WHERE id=?').get(id) ?? null;
  }

  function getPublicationByDraft(draftId) {
    return db.prepare('SELECT * FROM publications WHERE draft_id=? ORDER BY id DESC LIMIT 1').get(draftId) ?? null;
  }

  function listPublications({ limit = 100 } = {}) {
    return db.prepare(`SELECT pb.*, d.title AS draft_title FROM publications pb
      LEFT JOIN drafts d ON d.id = pb.draft_id ORDER BY pb.id DESC LIMIT ?`).all(Math.min(300, Math.max(1, limit)));
  }

  function touchPublication(contentId) {
    db.prepare('UPDATE publications SET last_pushed_at=?, updated_at=? WHERE content_id=?').run(now(), now(), String(contentId));
    return getPublicationByContent(contentId);
  }

  // ---------------------------------------------------------------- media cache

  function getMedia(sourceUrl) {
    return db.prepare('SELECT * FROM media_cache WHERE source_url=?').get(sourceUrl) ?? null;
  }

  function putMedia({ sourceUrl, cdnUrl, width, height, bytes }) {
    db.prepare(`INSERT OR REPLACE INTO media_cache(source_url,cdn_url,width,height,bytes,uploaded_at)
      VALUES(?,?,?,?,?,?)`).run(sourceUrl, cdnUrl, width, height, bytes, now());
    return getMedia(sourceUrl);
  }

  // ---------------------------------------------------------------- stats

  function stats() {
    const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM drafts GROUP BY status').all();
    const queueStates = db.prepare('SELECT state, COUNT(*) AS count FROM queue GROUP BY state').all();
    return {
      drafts: Object.fromEntries(statuses.map(row => [row.status, row.count])),
      queue: Object.fromEntries(queueStates.map(row => [row.state, row.count])),
    };
  }

  return {
    db,
    listAnnouncementSources,
    getAnnouncementSource,
    updateAnnouncementSource,
    listAnnouncementDrafts,
    listSubscriptions,
    getSubscription,
    findSubscription,
    addSubscription,
    updateSubscription,
    deleteSubscription,
    touchSubscription,
    findPostByKey,
    upsertPost,
    getPost,
    setPostStatus,
    createDraft,
    getDraft,
    getDraftByPost,
    listDrafts,
    countDrafts,
    updateDraft,
    setDraftStatus,
    activeQueueItem,
    enqueue,
    getQueueItem,
    listQueue,
    dueQueueItem,
    claimQueueItem,
    updateQueueItem,
    lastPublishedAt,
    countPublishedOn,
    recordPublication,
    getPublicationByContent,
    getPublicationById,
    getPublicationByDraft,
    listPublications,
    touchPublication,
    getMedia,
    putMedia,
    stats,
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
