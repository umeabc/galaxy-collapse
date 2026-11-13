import { AppError, truncate } from '../util.js';
import { plainTextFromMarkdown } from '../convert/markdown.js';
import { evaluateKeywords, parseKeywordList } from '../review/keywords.js';
import { AiReviewError, reviewWithAi } from '../review/ai.js';

/** 自动审核：关键字（允许/拦截/标记）→ AI（可配置提示词）→ 人工兜底。 */
export class ReviewService {
  constructor({ store, settings, log, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.fetchImpl = fetchImpl;
    /** 审核通过后的回调（由 app 注入 → queue.enqueue）。 */
    this.onApproved = null;
  }

  async reviewDraft(draftId) {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    if (draft.status === 'PUBLISHED') throw new AppError('已发布的草稿不能再审核', { code: 'ALREADY_PUBLISHED', status: 409 });

    const settings = this.settings.getSnapshot();
    this.store.setDraftStatus(draftId, 'REVIEWING');

    const text = `${draft.title}\n${plainTextFromMarkdown(draft.markdown)}`;
    const keywordResult = evaluateKeywords(text, {
      allow: parseKeywordList(settings.keywordAllow),
      block: parseKeywordList(settings.keywordBlock),
      flag: parseKeywordList(settings.keywordFlag),
    });

    const baseReview = {
      at: Date.now(),
      keyword: keywordResult.keyword,
      rule: keywordResult.rule,
    };

    if (keywordResult.decision === 'reject') {
      return this._finish(draftId, 'REJECTED', {
        ...baseReview,
        stage: 'keyword',
        verdict: 'reject',
        reason: `命中拦截关键词「${keywordResult.keyword}」`,
        confidence: 1,
      });
    }
    if (keywordResult.decision === 'flag') {
      return this._finish(draftId, 'NEEDS_REVIEW', {
        ...baseReview,
        stage: 'keyword',
        verdict: 'review',
        reason: `命中标记关键词「${keywordResult.keyword}」`,
        confidence: 1,
      });
    }
    if (keywordResult.decision === 'approve') {
      return this._finish(draftId, 'APPROVED', {
        ...baseReview,
        stage: 'keyword',
        verdict: 'approve',
        reason: `命中通过关键词「${keywordResult.keyword}」`,
        confidence: 1,
      });
    }

    if (!settings.aiEnabled) {
      return this._finish(draftId, 'NEEDS_REVIEW', {
        ...baseReview,
        stage: 'default',
        verdict: 'review',
        reason: '未命中关键字，且未启用 AI 审核',
        confidence: 0,
      });
    }

    try {
      const ai = await reviewWithAi({
        title: draft.title,
        author: draft.source_author || '',
        sourceUrl: draft.sourceUrl || '',
        content: plainTextFromMarkdown(draft.markdown),
        prompt: settings.aiPrompt,
        baseUrl: settings.aiBaseUrl,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        timeoutMs: 60000,
        minConfidence: settings.aiMinConfidence,
        fetchImpl: this.fetchImpl,
      });
      const status = ai.decision === 'approve' ? 'APPROVED' : ai.decision === 'reject' ? 'REJECTED' : 'NEEDS_REVIEW';
      return this._finish(draftId, status, {
        ...baseReview,
        stage: 'ai',
        verdict: ai.decision,
        reason: ai.reason || 'AI 审核完成',
        confidence: ai.confidence,
        risk: ai.risk,
        model: ai.model,
      });
    } catch (error) {
      const message = error instanceof AiReviewError ? error.message : 'AI 审核失败';
      const action = settings.aiOnError;
      const status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'NEEDS_REVIEW';
      this.log.write({
        level: 'warn',
        scope: 'review',
        event: 'review.ai_failed',
        message,
        details: { draftId, code: error?.code ?? null },
      });
      return this._finish(draftId, status, {
        ...baseReview,
        stage: 'ai',
        verdict: action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'review',
        reason: truncate(`AI 审核失败：${message}`, 200),
        confidence: 0,
        error: true,
      });
    }
  }

  _finish(draftId, status, review) {
    this.store.setDraftStatus(draftId, status, { review });
    this.log.write({
      level: status === 'REJECTED' ? 'warn' : 'info',
      scope: 'review',
      event: 'review.finished',
      message: `${status} · ${review.reason}`,
      details: { draftId, status, stage: review.stage, verdict: review.verdict, confidence: review.confidence },
    });
    if (status === 'APPROVED' && this.onApproved) {
      try {
        this.onApproved(draftId);
      } catch (error) {
        this.log.write({ level: 'error', scope: 'review', event: 'review.enqueue_failed', message: String(error?.message ?? error), details: { draftId } });
      }
    }
    return { draft: this.store.getDraft(draftId), review };
  }
}
