import { MalformedXml, childText, childrenNamed, readXml } from './xml-reader';

describe('a small XML document, as the front door reads one', () => {
  it('reads elements in order, their text with its entities, CDATA, and skips the declaration, comments, attributes and namespaces', () => {
    const root = readXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n<s3:Root xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/" a="1">' +
        '<Item><Name>a &amp; b &lt;c&gt; &#233;&#x1F600;</Name><Empty/></Item><Item><Name><![CDATA[<raw> & text]]></Name></Item></s3:Root>',
    );

    expect(root.name).toBe('Root');
    expect(childrenNamed(root, 'Item').map((item) => childText(item, 'Name'))).toEqual(['a & b <c> é😀', '<raw> & text']);
    expect(childrenNamed(childrenNamed(root, 'Item')[0], 'Empty')).toEqual([{ name: 'Empty', children: [], text: '' }]);
    expect(childText(root, 'Missing')).toBeUndefined();
  });

  it.each([
    ['<Root><A></B></Root>', '</B> closes <A>'],
    ['<Root><A></Root>', '</Root> closes <A>'],
    ['<Root>', '<Root> never closes'],
    ['<Root/><Again/>', 'a second root element'],
    ['text<Root/>', 'text outside the root element'],
    ['<!DOCTYPE x [<!ENTITY e "boom">]><Root>&e;</Root>', 'a DOCTYPE'],
    ['<Root>&e;</Root>', 'the entity &e;'],
    ['<Root>& alone</Root>', 'an entity without its ;'],
    ['<Root>&#0;</Root>', 'the reference &#0;'],
    ['<Root><1bad/></Root>', 'the tag <1bad/>'],
    ['', 'no root element'],
  ])('refuses %j: %s', (source, detail) => {
    expect(() => readXml(source)).toThrow(new MalformedXml(detail));
  });
});
