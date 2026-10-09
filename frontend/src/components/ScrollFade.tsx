import { useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes, Ref } from 'react';
import '../styles/scroll-fade.css';

type ScrollFadeProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'ul';
  ref?: Ref<HTMLElement>;
};

/** A scroll viewport with a bottom cue only while content remains below it. */
export function ScrollFade({ as: Tag = 'div', ref, className = '', ...props }: ScrollFadeProps) {
  const viewportRef = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => viewportRef.current!);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let disposed = false;
    let frame: number | null = null;
    let observedChildren: Element[] = [];

    const measure = () => {
      frame = null;
      if (disposed) return;
      const moreBelow = viewport.clientHeight > 0
        && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1;
      if (moreBelow) viewport.setAttribute('data-scroll-more', 'true');
      else viewport.removeAttribute('data-scroll-more');
    };
    const schedule = () => {
      if (!disposed && frame === null) frame = window.requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const observeContent = () => {
      const children = Array.from(viewport.children);
      if (children.length === observedChildren.length
        && children.every((child, index) => child === observedChildren[index])) return;
      observedChildren = children;
      resize?.disconnect();
      resize?.observe(viewport);
      // Content can grow without a mutation, e.g. images, fonts or wrapping.
      children.forEach((child) => resize?.observe(child));
    };
    resize?.observe(viewport);
    observeContent();
    const mutations = new MutationObserver(() => { observeContent(); schedule(); });
    mutations.observe(viewport, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    viewport.addEventListener('scroll', schedule, { passive: true });
    viewport.addEventListener('load', schedule, true);
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    void document.fonts?.ready.then(schedule);
    measure();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('load', schedule, true);
      window.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [Tag]);

  return <Tag {...props} className={`panel-scroll-fade ${className}`.trim()}
    ref={viewportRef as Ref<HTMLDivElement> & Ref<HTMLUListElement>} />;
}
