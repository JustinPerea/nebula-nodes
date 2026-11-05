import { DeferredRegionNotices } from '../../src/lib/deferredChunks';

/**
 * The notice region's own notices (RegionNotices) are a deferred chunk
 * (lib/deferredChunks.ts), mounted at once and drawing nothing until the
 * chunk lands. A test that renders <NoticeRegion> before the chunk is in
 * gets its first notices from a Suspense retry, a render React schedules on
 * its own after the import resolves, outside act(). A findBy sees that
 * commit's DOM, but the commit's passive effects (each store hook's
 * subscription) are still queued behind it, so a store change the test makes
 * next in act() reaches no component and the line keeps its old text. A busy
 * CI runner stretched that gap: pr198Fix23Ui "a rename during a try" read
 * "Opening" after the rename (run 41584394316, attempt 1).
 *
 * Load the chunk first (`beforeAll(regionNoticesReady)`): lazyWithPreload
 * then hands React the module synchronously, so render() commits the notices
 * and runs their effects inside act(). tests/regionNoticesReadyRatchet.test.ts
 * keeps every test file that renders <NoticeRegion> waiting on it.
 */
export async function regionNoticesReady(): Promise<void> {
  await DeferredRegionNotices.preload();
}
