/**
 * YAML 1.2 规范示例用例集（输入 → 期望值）
 *
 * 取自规范的块/流/标量章节示例（第 2 章速览、第 5–8 章），改写为等价的输入文本与期望值；
 * 不依赖任何外部 conformance 数据集，测试完全自包含。
 *
 * @typedef {object} SpecCase
 * @property {string} name 用例名（含规范章节号）
 * @property {string} yaml 输入文本
 * @property {any} expected 期望值
 * @property {boolean} [multi] 是否多文档（走 parseAll）
 */

/**
 * 规范示例用例
 * @type {ReadonlyArray<SpecCase>}
 */
export const SPEC_CASES = Object.freeze([
    {
        name: '2.1 序列',
        yaml: '- Mark McGwire\n- Sammy Sosa\n- Ken Griffey\n',
        expected: ['Mark McGwire', 'Sammy Sosa', 'Ken Griffey'],
    },
    {
        name: '2.2 映射',
        yaml: 'hr: 65\navg: 0.278\nrbi: 147\n',
        expected: { hr: 65, avg: 0.278, rbi: 147 },
    },
    {
        name: '2.3 映射的映射',
        yaml: 'american:\n  - Boston Red Sox\n  - Detroit Tigers\nnational:\n  - New York Mets\n',
        expected: { american: ['Boston Red Sox', 'Detroit Tigers'], national: ['New York Mets'] },
    },
    {
        name: '2.4 序列的映射',
        yaml: '-\n  name: Mark McGwire\n  hr: 65\n-\n  name: Sammy Sosa\n  hr: 63\n',
        expected: [{ name: 'Mark McGwire', hr: 65 }, { name: 'Sammy Sosa', hr: 63 }],
    },
    {
        name: '2.6 映射到序列（缩进式）',
        yaml: 'Mark McGwire: [65, 0.278, 147]\n',
        expected: { 'Mark McGwire': [65, 0.278, 147] },
    },
    {
        name: '2.10 内联嵌套（compact）',
        yaml: '- - one\n  - two\n- three\n',
        expected: [['one', 'two'], 'three'],
    },
    {
        name: '2.12 紧凑嵌套的映射',
        yaml: '---\n# Products purchased\n- item    : Super Hoop\n  quantity: 1\n- item    : Basketball\n  quantity: 4\n',
        expected: [{ item: 'Super Hoop', quantity: 1 }, { item: 'Basketball', quantity: 4 }],
    },
    {
        name: '2.13 字面块标量',
        yaml: '# ASCII Art\n--- |\n  \\//||\\/||\n  // ||  ||__\n',
        expected: '\\//||\\/||\n// ||  ||__\n',
    },
    {
        name: '2.14 折叠标量',
        yaml: '--- >\n  Mark McGwire\'s\n  year was crippled\n  by a knee injury.\n',
        expected: "Mark McGwire's year was crippled by a knee injury.\n",
    },
    {
        name: '2.15 折叠块标量（含空行）',
        yaml: '>\n Sammy Sosa completed another\n fine season with great stats.\n\n   63 home runs\n   0.288 batting average\n',
        expected: 'Sammy Sosa completed another fine season with great stats.\n\n  63 home runs\n  0.288 batting average\n',
    },
    {
        name: '2.16 缩进决定内容范围',
        yaml: 'name: Mark McGwire\naccomplishment: >\n  Mark set a major league\n  home run record in 1998.\nstats: |\n  65 Home Runs\n  0.278 Batting Average\n',
        expected: {
            name: 'Mark McGwire',
            accomplishment: 'Mark set a major league home run record in 1998.\n',
            stats: '65 Home Runs\n0.278 Batting Average\n',
        },
    },
    {
        name: '2.17 引号标量',
        yaml: 'unicode: "Sosa did fine.\\u263A"\ncontrol: "\\b1998\\t1999\\t2000\\n"\nhex esc: "\\x0d\\x0a is \\r\\n"\nsingle: \'"Howdy!" he cried.\'\nquoted: \' # Not a \'\'comment\'\'.\'\n',
        expected: {
            unicode: 'Sosa did fine.\u263A',
            control: '\b1998\t1999\t2000\n',
            'hex esc': '\r\n is \r\n',
            single: '"Howdy!" he cried.',
            quoted: " # Not a 'comment'.",
        },
    },
    {
        name: '2.18 多行流式标量',
        yaml: 'plain:\n  This unquoted scalar\n  spans many lines.\n\nquoted: "So does this\n  quoted scalar.\\n"\n',
        expected: {
            plain: 'This unquoted scalar spans many lines.',
            quoted: 'So does this quoted scalar.\n',
        },
    },
    {
        name: '5.3 块结构',
        yaml: 'sequence:\n- one\n- two\nmapping:\n  ? sky\n  : blue\n  sea : green\n',
        expected: { sequence: ['one', 'two'], mapping: { sky: 'blue', sea: 'green' } },
    },
    {
        name: '5.4 流式结构',
        yaml: 'sequence: [ one, two, ]\nmapping: { sky: blue, sea: green }\n',
        expected: { sequence: ['one', 'two'], mapping: { sky: 'blue', sea: 'green' } },
    },
    {
        name: '5.5 注释',
        yaml: '# Comment only.\n',
        expected: null,
    },
    {
        name: '6.1 缩进',
        yaml: '  # Leading comment line spaces are\n   # neither content nor indentation.\n\nNot indented:\n By one space: |\n    By four\n      spaces\n Flow style: [    # Leading spaces\n   By two,        # in flow style\n  Also by two,    # are neither\n  \tStill by two   # content nor\n    ]             # indentation.\n',
        expected: {
            'Not indented': {
                'By one space': 'By four\n  spaces\n',
                'Flow style': ['By two', 'Also by two', 'Still by two'],
            },
        },
    },
    {
        name: '6.3 分离空格：制表符可作分隔',
        yaml: '- foo:\tbar\n- - baz\n  -\tbaz\n',
        expected: [{ foo: 'bar' }, ['baz', 'baz']],
    },
    {
        name: '6.4 行前缀',
        yaml: 'plain: text\n  lines\nquoted: "text\n  \tlines"\nblock: |\n  text\n   \tlines\n',
        expected: { plain: 'text lines', quoted: 'text lines', block: 'text\n \tlines\n' },
    },
    {
        name: '6.5 空行',
        yaml: 'Folding:\n  "Empty line\n\n  as a line feed"\nChomping: |\n  Clipped empty lines\n \n',
        expected: { Folding: 'Empty line\nas a line feed', Chomping: 'Clipped empty lines\n' },
    },
    {
        name: '6.6 行折叠',
        yaml: '>-\n  trimmed\n  \n \n\n  as\n  space\n',
        expected: 'trimmed\n\n\nas space',
    },
    {
        name: '6.8 流式折叠',
        yaml: 'quoted: "So does this\n  quoted scalar.\\n"\n',
        expected: { quoted: 'So does this quoted scalar.\n' },
    },
    {
        name: '6.16 标签简写',
        yaml: '!!str 123\n',
        expected: '123',
    },
    {
        name: '6.20 标签句柄',
        yaml: '%TAG !e! tag:yaml.org,2002:\n---\n!e!str 123\n',
        expected: '123',
    },
    {
        name: '7.1 别名节点',
        yaml: 'First occurrence: &anchor Value\nSecond occurrence: *anchor\n',
        expected: { 'First occurrence': 'Value', 'Second occurrence': 'Value' },
    },
    {
        name: '7.2 文档标记',
        yaml: '%YAML 1.2\n---\nDocument\n...\n',
        expected: 'Document',
    },
    {
        name: '7.3 裸文档',
        yaml: 'Bare document\n',
        expected: 'Bare document',
    },
    {
        name: '7.4 显式文档',
        yaml: '---\nExplicit document\n',
        expected: 'Explicit document',
    },
    {
        name: '8.1 块标量头部',
        yaml: 'strip: |-\n  text\nclip: |\n  text\nkeep: |+\n  text\n',
        expected: { strip: 'text', clip: 'text\n', keep: 'text\n' },
    },
    {
        name: '字面块标量：缩进与制表符',
        yaml: '|\n  literal\n  \ttext\n\n',
        expected: 'literal\n\ttext\n',
    },
    {
        name: '折叠标量：空行与更深缩进行',
        yaml: '>\n\n  folded\n  line\n\n  next\n  line\n  \n    * bullet\n\n    * list\n    * lines\n\n  last\n  line\n',
        expected: '\nfolded line\nnext line\n\n  * bullet\n\n  * list\n  * lines\n\nlast line\n',
    },
    {
        name: '字面块标量：末尾空行被 clip 去掉',
        yaml: '|\n literal\n \ttext\n\n',
        expected: 'literal\n\ttext\n',
    },
    {
        name: '8.10 折叠标量（保留）',
        yaml: '>+\n folded\n text\n\n',
        expected: 'folded text\n\n',
    },
    {
        name: '8.12 显式缩进指示符',
        yaml: '|2\n  explicit\n',
        expected: 'explicit\n',
    },
    {
        name: '8.13 缩进指示符与内容',
        yaml: '? |-\n  explicit\n: value\n',
        expected: { explicit: 'value' },
    },
    {
        name: '8.14 块序列作为映射值',
        yaml: 'block sequence:\n- one\n- two\n',
        expected: { 'block sequence': ['one', 'two'] },
    },
    {
        name: '8.15 块序列条目',
        yaml: '-\n  - one\n  - two\n',
        expected: [['one', 'two']],
    },
    {
        name: '8.16 块映射',
        yaml: '? explicit key # Empty value\n? |\n  block key\n: - one # Explicit compact\n  - two # block value\n',
        expected: { 'explicit key': null, 'block key\n': ['one', 'two'] },
    },
    {
        name: '8.18 块标量作为键',
        yaml: '? |\n  a\n  b\n: c\n',
        expected: { 'a\nb\n': 'c' },
    },
    {
        name: '8.19 紧凑块序列',
        yaml: '- one\n- two\n- three\n',
        expected: ['one', 'two', 'three'],
    },
    {
        name: '8.20 块节点类型',
        yaml: '-\n  "quoted"\n- &anchor\n  - item\n- !!str 123\n- |\n  literal\n- >\n  folded\n',
        expected: ['quoted', ['item'], '123', 'literal\n', 'folded\n'],
    },
    {
        name: '9.1 文档前缀（指令）',
        yaml: '%YAML 1.2\n%TAG !e! tag:yaml.org,2002:\n---\n!e!str x\n',
        expected: 'x',
    },
    {
        name: '9.5 指令与文档边界',
        yaml: '%YAML 1.2\n---\nfirst\n---\nsecond\n',
        expected: ['first', 'second'],
        multi: true,
    },
    {
        name: '9.6 流式节点（嵌套）',
        yaml: '{\n  "adjacent": [1, 2],\n  empty: {},\n  list: [{a: 1}, {b: 2}]\n}\n',
        expected: { adjacent: [1, 2], empty: {}, list: [{ a: 1 }, { b: 2 }] },
    },
]);
