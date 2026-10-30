/* Run inspectReaderLayout() in DevTools at each viewport, without API calls. */
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
  }
  return {viewport: [innerWidth, innerHeight], bookWidth: Math.round(rect(book).width),
    artHeight: Math.round(rect(art).height), textHeight: Math.round(rect(text).height),
    columns: getComputedStyle(book).gridTemplateColumns, failures, pass: !failures.length};
}
