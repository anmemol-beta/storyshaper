/* Paste into DevTools, then run JSON.stringify(inspectReaderLayout()) at each
   viewport. Test cover, active story, choices and open settings without paid calls.
   Vertical scrolling is allowed; collapsed panels and clipped controls are not. */
function inspectReaderLayout() {
  const rect = element => element.getBoundingClientRect();
  const book = document.querySelector('.book');
  const shell = document.querySelector('.shell');
  const text = document.querySelector('.text-panel');
  const art = document.querySelector('.art');
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const controls = [...document.querySelectorAll('button, select, input:not([type="checkbox"])')].filter(visible);
  const failures = [];
  if (rect(book).width < rect(shell).width * .9) failures.push('book width collapsed');
  if (rect(art).height < 120 || rect(text).height < 120) failures.push('reading panel collapsed');
  if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('horizontal overflow');
  for (const element of controls) {
    const bounds = rect(element);
    if (bounds.left < -1 || bounds.right > innerWidth + 1) failures.push('control outside viewport: ' + element.id);
    if (bounds.height < 44) failures.push('small touch target: ' + element.id);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), area = rect(parent);
      if (['hidden', 'clip'].includes(style.overflowY) &&
          (bounds.top < area.top - 2 || bounds.bottom > area.bottom + 2)) {
        failures.push('clipped control: ' + element.id);
        break;
      }
    }
  }
  const microphone = document.querySelector('#mic');
  const camera = document.querySelector('#cameraButton');
  if (microphone && camera && visible(microphone) && visible(camera) &&
      rect(microphone).left < rect(camera).right) failures.push('microphone moved left of camera');
  return {viewport: [innerWidth, innerHeight], bookWidth: Math.round(rect(book).width),
    artHeight: Math.round(rect(art).height), textHeight: Math.round(rect(text).height),
    columns: getComputedStyle(book).gridTemplateColumns, failures, pass: !failures.length};
}
