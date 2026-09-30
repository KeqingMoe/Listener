// Keep this fallback synchronous so an insecure-HTTP click retains user activation.
function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index++) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  const anchorNode = selection?.anchorNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusNode = selection?.focusNode;
  const focusOffset = selection?.focusOffset ?? 0;
  const input =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active
      : null;
  const inputSelection =
    input && input.selectionStart !== null
      ? {
          start: input.selectionStart,
          end: input.selectionEnd,
          direction: input.selectionDirection,
        }
      : null;
  const scroll = new Map<Element, { top: number; left: number }>();
  function rememberScroll(node: Node | null | undefined) {
    let element = node instanceof Element ? node : node?.parentElement;
    while (element) {
      scroll.set(element, { top: element.scrollTop, left: element.scrollLeft });
      element = element.parentElement;
    }
  }
  rememberScroll(active);
  rememberScroll(anchorNode);
  rememberScroll(focusNode);
  rememberScroll(document.scrollingElement);
  const windowScroll = { x: window.scrollX, y: window.scrollY };
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;font-size:16px;';
  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return (
      typeof document.execCommand === 'function' &&
      document.execCommand('copy') === true
    );
  } catch {
    return false;
  } finally {
    textarea.remove();
    try {
      active?.focus({ preventScroll: true });
    } catch {
      /* A removed element cannot regain focus. */
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) {
          selection.addRange(range);
        }
        if (
          ranges.length === 1 &&
          anchorNode &&
          focusNode &&
          selection.setBaseAndExtent
        ) {
          selection.setBaseAndExtent(
            anchorNode,
            anchorOffset,
            focusNode,
            focusOffset,
          );
        }
      }
      if (input && inputSelection) {
        input.setSelectionRange(
          inputSelection.start,
          inputSelection.end,
          inputSelection.direction ?? undefined,
        );
      }
    } catch {
      /* The original selection may no longer exist. */
    }
    for (const [element, position] of scroll) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
    if (
      window.scrollX !== windowScroll.x ||
      window.scrollY !== windowScroll.y
    ) {
      window.scrollTo(windowScroll.x, windowScroll.y);
    }
  }
}

/** A true result means a browser copy operation actually reported success. */
export function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.writeText === 'function'
    ) {
      return Promise.resolve(navigator.clipboard.writeText(text)).then(
        () => true,
        () => copyWithTextarea(text),
      );
    }
  } catch {
    /* Missing permissions or a throwing API still get the legacy fallback. */
  }
  return Promise.resolve(copyWithTextarea(text));
}
