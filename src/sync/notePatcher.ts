import type { NotePatch } from '../types/productboard';
import * as pbClient from './productboard';
import { ApiError } from './rateLimit';

// Phase 4 — content-lock fallback (D13).
//
// PB returns HTTP 422 with `validation.forbidden` on `/data/fields/content`
// when a note has any feature relationship attached. Other field PATCHes on
// the same note (`name`, `tags`, `owner`, `archived`) succeed — only `content`
// is gated. The fallback algorithm — implemented below verbatim from
// planning-docs/plan-deals-support.md — has two paths:
//
//   - Safe (default): drop content, retry with name + tags + owner only.
//   - Force (opt-in via `config.forceContentUpdates`): unlink every feature
//     relationship, PATCH content, then re-create each relationship in the
//     original order. Snippet excerpts and importance scores are silently
//     destroyed (live-tested 2026-05-02). Only invoke when the user has
//     explicitly enabled the toggle in Settings.

// Live-tested 2026-05-02 — exact 422 response shape:
//   {
//     "errors": [{
//       "code": "validation.forbidden",
//       "detail": "Cannot update content for notes with linked features",
//       "source": { "pointer": "/data/fields/content" }
//     }]
//   }
function isContentLocked422(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 422) return false;
  const body = err.responseBody as { errors?: Array<{ code?: string; source?: { pointer?: string } }> } | null;
  if (!body || !Array.isArray(body.errors)) return false;
  return body.errors.some(
    e => e.code === 'validation.forbidden' && e.source?.pointer === '/data/fields/content',
  );
}

// Strip the `content` field from a NotePatch in-place-safe fashion. Handles
// both PATCH shapes — `data.fields.content` (whole-replace) and
// `data.patch[]` ops whose path is `content`.
function withoutContent(patch: NotePatch): NotePatch {
  const fields = patch.data.fields ? { ...patch.data.fields } : undefined;
  if (fields) delete fields.content;

  const ops = patch.data.patch?.filter(op => op.path !== 'content');

  return {
    data: {
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
      ...(ops && ops.length > 0 ? { patch: ops } : {}),
    },
  };
}

/**
 * Unlinks all feature relationships from a note, patches content, then relinks them.
 *
 * DESTRUCTIVE: Productboard "snippets" are text selections a user made when linking
 * a feature in the PB UI. The relationship API does not expose snippet metadata
 * (text range, importance score). Deleting and recreating the relationship preserves
 * the bare feature link only — the snippet text anchor and its importance score
 * are silently destroyed and cannot be restored via API.
 *
 * Only call this when config.forceContentUpdates === true. The user opted in via
 * Settings → "Force content updates on linked notes".
 *
 * Verified behavior live-tested 2026-05-02 on excellence-kmtz-1.productboard.com.
 * See docs/internal/deals-sync-limitations.md for full details.
 */
export async function unlinkPatchRelink(
  noteId: string,
  fullPatch: NotePatch,
): Promise<{ linksRecycled: number }> {
  // Capture every relationship (link + customer) so we can recreate them in
  // the original order. The relationship objects carry no stable id field —
  // identity is `(target.type, target.id)`. We only ever delete + recreate
  // `link`-type relationships; customer links survive content patches and
  // would 4xx if we tried to redelete them.
  const all = await pbClient.getDealNoteRelationships(noteId);
  const linkRels = all.filter(r => r.type === 'link');
  const captured = linkRels.map(r => ({ targetId: r.target.id }));

  for (const c of captured) {
    await pbClient.unlinkDealNoteRelationship(noteId, c.targetId);
  }

  await pbClient.patchDealNote(noteId, fullPatch);

  for (const c of captured) {
    await pbClient.relinkDealNoteRelationship(noteId, c.targetId);
  }

  return { linksRecycled: captured.length };
}

export interface PatchOutcome {
  status: 'patched' | 'patched-without-content' | 'patched-via-relink';
  linksRecycled?: number;
}

/**
 * Drives the content-lock fallback. Engines call this instead of patching the
 * note directly so the destructive-vs-safe branch lives in one place.
 *
 * Algorithm (from plan-deals-support.md):
 *   1. Try the full PATCH.
 *   2. On a content-locked 422, branch on `forceContentUpdates`:
 *        - false: drop content, PATCH everything else.
 *        - true:  unlinkPatchRelink with the full patch.
 *
 * Any other error rethrows for the engine's outer try/catch to record.
 */
export async function patchDealNoteContent(
  noteId: string,
  fullPatch: NotePatch,
  opts: { forceContentUpdates: boolean },
): Promise<PatchOutcome> {
  try {
    await pbClient.patchDealNote(noteId, fullPatch);
    return { status: 'patched' };
  } catch (err) {
    if (!isContentLocked422(err)) throw err;

    if (!opts.forceContentUpdates) {
      const safe = withoutContent(fullPatch);
      // If `content` was the only field in the patch, there's nothing left to
      // write — treat as a no-op rather than firing an empty PATCH PB would
      // 400 on. The caller still increments contentSkipped.
      const hasFields = !!(safe.data.fields && Object.keys(safe.data.fields).length > 0);
      const hasOps    = !!(safe.data.patch  && safe.data.patch.length  > 0);
      if (hasFields || hasOps) {
        await pbClient.patchDealNote(noteId, safe);
      }
      console.warn(`Content skipped for note ${noteId}: linked features prevent content update`);
      return { status: 'patched-without-content' };
    }

    const { linksRecycled } = await unlinkPatchRelink(noteId, fullPatch);
    console.warn(`Force-patched note ${noteId}: ${linksRecycled} snippet(s) stripped`);
    return { status: 'patched-via-relink', linksRecycled };
  }
}
