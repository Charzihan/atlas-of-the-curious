import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2], out = process.argv[3];
const sjis = f => new TextDecoder('shift_jis').decode(readFileSync(`${dir}/${f}`));
// Aozora Bunko: drop the header, ruby readings, ruby markers and editor notes; keep the body.
const aozora = (f, chars) => {
  let t = sjis(f);
  t = t.split(/-{20,}/).slice(2).join('');
  t = t.replace(/《[^》]*》/g, '').replace(/｜/g, '').replace(/［＃[^］]*］/g, '');
  t = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('');
  t = t.replace(/^[一二三四五六七八九十]+(、[^「]*)?/, '');
  return t.slice(0, chars).replace(/(。」?)[^。]*$/, '$1');
};
const gutenberg = (f, start, chars, end) => {
  const t = readFileSync(`${dir}/${f}`, 'utf8').replace(/\r/g, '');
  const at = t.indexOf(start);
  if (at < 0) throw new Error(`${f}: start not found`);
  const stop = end ? t.indexOf(end, at) : -1;
  const text = t.slice(at, stop > 0 ? stop : at + chars * 1.3).replace(/_/g, '').replace(/\s+/g, ' ').trim();
  // Cut long passages at a word boundary; a whole poem stays whole.
  return text.length <= chars ? text : text.slice(0, chars).replace(/([.!?]["']?)[^.!?]*$/, '$1');
};
const tang = JSON.parse(readFileSync(`${dir}/tang300.json`, 'utf8'));
const poems = tang.content.flatMap(group => group.content);
const pick = ['靜夜思', '登鸛雀樓', '春曉', '相思', '春望', '黃鶴樓', '將進酒', '月下獨酌', '楓橋夜泊', '江雪', '早發白帝城', '登高'];
const zh = pick.map(title => poems.find(p => p.chapter === title)).filter(Boolean);
const lit = {
  zh: { name: 'Chinese', wide: true, separator: '　', passages: zh.map(p => ({ text: p.paragraphs.join(''), source: `${p.author}《${p.chapter}》` })) },
  ja: { name: 'Japanese', wide: true, separator: '　', passages: [
    { text: aozora('neko.txt', 420), source: '夏目漱石『吾輩は猫である』' },
    { text: aozora('ja-752_ruby_2438.txt', 360), source: '夏目漱石『坊っちゃん』' },
    { text: aozora('ja-127_ruby_150.txt', 360), source: '芥川龍之介『羅生門』' },
    { text: aozora('ja-456_ruby_145.txt', 300), source: '宮沢賢治『銀河鉄道の夜』' },
  ] },
  en: { name: 'English', wide: false, separator: ' — ', passages: [
    { text: gutenberg('en-1342.txt', 'It is a truth universally acknowledged', 700), source: 'Jane Austen, Pride and Prejudice' },
    { text: gutenberg('en-98.txt', 'It was the best of times', 700), source: 'Charles Dickens, A Tale of Two Cities' },
    { text: gutenberg('en-2701.txt', 'Call me Ishmael', 700), source: 'Herman Melville, Moby-Dick' },
    { text: gutenberg('en-1041.txt', 'Shall I compare thee', 900, 'XIX'), source: 'William Shakespeare, Sonnet 18' },
  ] },
};
writeFileSync(out, JSON.stringify(lit, null, 1));
for (const [k, v] of Object.entries(lit)) for (const p of v.passages) console.log(k, p.source, '|', p.text.slice(0, 70));
