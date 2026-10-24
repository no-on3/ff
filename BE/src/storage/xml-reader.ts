/** An element of a small XML document: its local name, its elements in order, and its text, entities read. */
export interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

/** A document that isn't well-formed XML, or one with a DOCTYPE, which no S3 document has. */
export class MalformedXml extends Error {
  constructor(detail: string) {
    super(`Malformed XML: ${detail}`);
    this.name = 'MalformedXml';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text with its entities read: the five XML names and numeric references; any other is malformed. */
function decodeText(text: string): string {
  return text.replace(/&([^;&\s]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new MalformedXml('an entity without its ;');
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) throw new MalformedXml(`the reference &${name};`);
      return String.fromCodePoint(code);
    }
    const known = ENTITIES[name];
    if (known === undefined) throw new MalformedXml(`the entity &${name};`);
    return known;
  });
}

/** An element's name without its namespace's prefix. */
const localName = (qualified: string): string => qualified.slice(qualified.indexOf(':') + 1);

/**
 * Reads a small XML document, such as an S3 request's configuration, into
 * its elements: tags, attributes (skipped), text, CDATA, comments and the
 * declaration. A DOCTYPE is refused, so that no entity of the document's own
 * is ever read. Mixed content keeps its text pieces together.
 */
export function readXml(source: string): XmlElement {
  let at = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const expect = (found: number, what: string) => {
    if (found === -1) throw new MalformedXml(`${what} never ends`);
    return found;
  };
  while (at < source.length) {
    const open = source.indexOf('<', at);
    const text = source.slice(at, open === -1 ? source.length : open);
    if (stack.length > 0) stack[stack.length - 1].text += decodeText(text);
    else if (text.trim() !== '') throw new MalformedXml('text outside the root element');
    if (open === -1) break;
    if (source.startsWith('<?', open)) {
      at = expect(source.indexOf('?>', open), 'a declaration') + 2;
    } else if (source.startsWith('<!--', open)) {
      at = expect(source.indexOf('-->', open), 'a comment') + 3;
    } else if (source.startsWith('<![CDATA[', open)) {
      const end = expect(source.indexOf(']]>', open), 'a CDATA section');
      if (stack.length === 0) throw new MalformedXml('CDATA outside the root element');
      stack[stack.length - 1].text += source.slice(open + 9, end);
      at = end + 3;
    } else if (source.startsWith('<!', open)) {
      throw new MalformedXml('a DOCTYPE');
    } else if (source.startsWith('</', open)) {
      const end = expect(source.indexOf('>', open), 'a closing tag');
      const name = localName(source.slice(open + 2, end).trim());
      const element = stack.pop();
      if (!element || element.name !== name) throw new MalformedXml(`</${name}> closes ${element ? `<${element.name}>` : 'nothing'}`);
      if (stack.length === 0) root = element;
      at = end + 1;
    } else {
      const end = expect(source.indexOf('>', open), 'a tag');
      const tag = source.slice(open + 1, end);
      const selfClosing = tag.endsWith('/');
      const name = localName((selfClosing ? tag.slice(0, -1) : tag).trim().split(/\s/)[0] ?? '');
      if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new MalformedXml(`the tag <${tag}>`);
      if (root) throw new MalformedXml('a second root element');
      const element: XmlElement = { name, children: [], text: '' };
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      else if (selfClosing) root = element;
      if (!selfClosing) stack.push(element);
      at = end + 1;
    }
  }
  if (stack.length > 0) throw new MalformedXml(`<${stack[stack.length - 1].name}> never closes`);
  if (!root) throw new MalformedXml('no root element');
  return root;
}

/** The element's children of that name. */
export const childrenNamed = (element: XmlElement, name: string): XmlElement[] => element.children.filter((child) => child.name === name);

/** The text of the element's one child of that name, trimmed; undefined when it has none. */
export function childText(element: XmlElement, name: string): string | undefined {
  const [child] = childrenNamed(element, name);
  return child?.text.trim();
}
