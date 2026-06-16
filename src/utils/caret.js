/**
 * Compute the pixel coordinates of the caret inside a <textarea>, relative to
 * the textarea's own box (before scroll). Uses the well-known "mirror div"
 * technique: render a hidden div with the same text styling and measure where a
 * marker span lands. Returns { top, left, height }.
 *
 * Adapted (trimmed) from textarea-caret-position (MIT, component/textarea-caret-position).
 */
const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
];

export function getCaretCoordinates(element, position) {
  const div = document.createElement('div');
  const style = div.style;
  const computed = window.getComputedStyle(element);

  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';

  MIRROR_PROPS.forEach((prop) => {
    style[prop] = computed[prop];
  });

  // Overflow must be hidden so the mirror wraps exactly like the textarea.
  style.overflow = 'hidden';

  document.body.appendChild(div);

  div.textContent = element.value.substring(0, position);
  // Replace spaces so trailing whitespace is measured.
  div.textContent = div.textContent.replace(/\s$/, ' ');

  const span = document.createElement('span');
  // A non-empty marker so it has a measurable position.
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10),
  };

  document.body.removeChild(div);
  return coordinates;
}
