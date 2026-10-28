import { deferredModule } from './lazyWithPreload';

/**
 * The dialog before the person's direct run of agents' paid placeholders
 * (Q133; components/askPlaceholderRun.tsx), loaded when the run asks
 * (store/graphStore.ts) and preloaded on idle (lib/deferredChunks.ts).
 * Its own module so the store needn't import deferredChunks (which pulls
 * every lazy panel's wrapper into the store's import graph).
 */
export const placeholderRunDialogModule = deferredModule(() => import('../components/askPlaceholderRun'));
