/**
 * ABAP language definition for highlight.js
 */
import hljs from 'highlight.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const abapLang: any = function (hljs: any) {
  const COMMENT_MODE = hljs.COMMENT(/"/, /$/);
  // * comment in column 1
  const STAR_COMMENT = {
    className: 'comment',
    begin: /^\*/,
    end: /$/,
    relevance: 0,
  };

  // String templates: |Hello { var } world|
  const STRING_TEMPLATE = {
    className: 'string',
    begin: /\|/,
    end: /\|/,
    contains: [
      {
        begin: /\{/,
        end: /\}/,
        contains: ['self' as const],
      },
    ],
  };

  const STRING = {
    className: 'string',
    begin: /'/,
    end: /'/,
    contains: [{ match: /''/ }],
  };

  const NUMBER = {
    className: 'number',
    relevance: 0,
    variants: [
      { begin: /\b\d+(\.\d+)?([eE][+-]?\d+)?\b/ },
    ],
  };

  // ABAP keyword system - organized by category
  const DECLARATION_KEYWORDS = [
    'DATA', 'TYPES', 'FIELD-SYMBOLS', 'CONSTANTS', 'STATICS',
    'PARAMETERS', 'SELECT-OPTIONS', 'RANGES', 'TABLES',
    'CLASS-DATA', 'CLASS-METHODS', 'CLASS-EVENTS',
    'EVENTS', 'METHODS',
  ];

  const CONTROL_KEYWORDS = [
    'IF', 'ELSE', 'ELSEIF', 'ENDIF',
    'CASE', 'WHEN', 'ENDCASE',
    'DO', 'ENDDO',
    'WHILE', 'ENDWHILE',
    'LOOP', 'ENDLOOP',
    'AT', 'ENDAT',
    'CHECK', 'EXIT', 'CONTINUE', 'RETURN',
    'TRY', 'CATCH', 'ENDTRY', 'CLEANUP', 'RETRY',
    'RAISE', 'RAISING',
  ];

  const MODULARIZATION_KEYWORDS = [
    'FORM', 'ENDFORM', 'PERFORM',
    'FUNCTION', 'ENDFUNCTION',
    'MODULE', 'ENDMODULE',
    'METHOD', 'ENDMETHOD',
    'CLASS', 'ENDCLASS',
    'INTERFACE', 'ENDINTERFACE',
  ];

  const OO_KEYWORDS = [
    'PUBLIC', 'PROTECTED', 'PRIVATE',
    'INHERITING', 'FINAL', 'ABSTRACT',
    'IMPLEMENTATION',
    'CREATE', 'OBJECT', 'INSTANCE',
    'DEFINITION', 'DEFERRED',
    'READ-ONLY', 'LOCAL', 'GLOBAL',
    'CASTING', 'TYPE', 'REF', 'VALUE',
    'EXPORTING', 'IMPORTING', 'CHANGING', 'RECEIVING', 'RETURNING',
    'OPTIONAL', 'DEFAULT', 'PREFERRED',
  ];

  const SQL_KEYWORDS = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MODIFY',
    'FROM', 'INTO', 'TABLE', 'WHERE',
    'AND', 'OR', 'NOT',
    'GROUP', 'BY', 'ORDER', 'HAVING',
    'INNER', 'JOIN', 'LEFT', 'OUTER', 'RIGHT',
    'AS', 'ON', 'FOR', 'ALL', 'ENTRIES',
    'UP', 'TO', 'ROWS',
    'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
    'LIKE', 'BETWEEN', 'IN', 'IS', 'NULL',
    'EXISTS', 'WITH',
  ];

  const ABAP_KEYWORDS = [
    'REPORT', 'PROGRAM',
    'MOVE-CORRESPONDING',
    'MOVE', 'WRITE', 'READ', 'APPEND',
    'CLEAR', 'FREE', 'REFRESH',
    'SORT', 'DELETE', 'MODIFY',
    'COLLECT', 'INSERT', 'DESCRIBE',
    'CONCATENATE', 'SPLIT', 'REPLACE', 'TRANSLATE', 'CONDENSE',
    'STRLEN', 'FIND', 'SHIFT',
    'ASSIGN', 'UNASSIGN',
    'GET', 'SET', 'CALL',
    'SUBMIT', 'LEAVE', 'MESSAGE',
    'NEW', 'NEW-PAGE', 'NEW-LINE',
    'INITIALIZATION', 'START-OF-SELECTION', 'END-OF-SELECTION',
    'TOP-OF-PAGE', 'END-OF-PAGE',
    'AT', 'SELECTION-SCREEN', 'AT', 'LINE-SELECTION',
    'SY-TABIX', 'SY-INDEX', 'SY-SUBRC', 'SY-DATUM', 'SY-UZEIT',
    'SY-UNAME', 'SY-MANDT', 'SY-LANGU', 'SY-TCODE',
    'SY-LSIND', 'SY-LINCT', 'SY-LINSZ', 'SY-PAGNO',
    'SY-VLINE', 'SY-ULINE', 'SY-COLNO', 'SY-COLNO',
    'SY-DBCNT', 'SY-FDPOS', 'SY-TFILL', 'SY-TLENG',
    'SY-MSGID', 'SY-MSGNO', 'SY-MSGTY', 'SY-MSGV1',
    'SY-MSGV2', 'SY-MSGV3', 'SY-MSGV4',
  ];

  const BUILTIN_TYPES = [
    'CHAR', 'NUMC', 'DEC', 'INT', 'INT1', 'INT2', 'INT4', 'INT8',
    'FLOAT', 'DECFLOAT16', 'DECFLOAT34', 'DATS', 'TIMS',
    'STRING', 'XSTRING', 'RAW', 'RAWSTRING',
    'CURR', 'CUKY', 'UNIT', 'LANG', 'CLNT', 'ACCP',
    'BOOLEAN', 'ABAP_BOOLEAN',
    'ABAP_CHAR', 'ABAP_NUMC', 'ABAP_DEC', 'ABAP_INT4', 'ABAP_INT8',
    'ABAP_FLOAT', 'ABAP_DECFLOAT16', 'ABAP_DECFLOAT34',
    'ABAP_DATS', 'ABAP_TIMS', 'ABAP_STRING', 'ABAP_XSTRING',
    'ABAP_CURR', 'ABAP_CUKY', 'ABAP_UNIT', 'ABAP_LANG', 'ABAP_CLNT',
    'ABAP_BOOL',
  ];

  const BUILTIN_FUNCTIONS = [
    'CALL', 'FUNCTION', 'METHOD',
    'NEW', 'CREATE', 'OBJECT',
    'CAST',
    'CONV', 'COND', 'SWITCH', 'VALUE', 'CORRESPONDING', 'EXACT',
    'REF', 'REDUCE', 'FILTER',
    'LINE_EXISTS', 'LINE_INDEX',
    'XSDBOOL', 'BOOLC', 'BOOLD',
  ];

  const OPERATORS = [
    'EQ', 'NE', 'LT', 'GT', 'LE', 'GE',
    'CO', 'CN', 'CA', 'NA', 'CS', 'NS',
    'CP', 'NP',
    'IS', 'NOT', 'AND', 'OR',
    'BETWEEN', 'IN',
    'INITIAL', 'ASSIGNED', 'BOUND', 'SUPPLIED', 'INSTANCE',
  ];

  // ABAP annotations (prefixed with @)
  const ANNOTATION = {
    className: 'meta',
    begin: /@\w+/,
    relevance: 5,
  };

  return {
    name: 'ABAP',
    aliases: ['abap'],
    case_insensitive: true,
    keywords: {
      $pattern: /\w+[\w-]*/,
      keyword: [
        ...DECLARATION_KEYWORDS,
        ...CONTROL_KEYWORDS,
        ...MODULARIZATION_KEYWORDS,
        ...OO_KEYWORDS,
        ...SQL_KEYWORDS,
        ...ABAP_KEYWORDS,
        ...BUILTIN_FUNCTIONS,
        ...OPERATORS,
      ],
      type: BUILTIN_TYPES,
      literal: ['ABAP_TRUE', 'ABAP_FALSE', 'NULL', 'INITIAL', 'SPACE'],
    },
    contains: [
      COMMENT_MODE,
      STAR_COMMENT,
      STRING_TEMPLATE,
      STRING,
      NUMBER,
      ANNOTATION,
      // Field access with ->
      {
        match: /->/,
        className: 'operator',
      },
      // Component selector ~ (CDS)
      {
        match: /~/,
        className: 'operator',
      },
      // Method chaining / functional call =>
      {
        match: /=>/,
        className: 'operator',
      },
    ],
  };
};

export function registerAbapLanguage() {
  hljs.registerLanguage('abap', abapLang);
}
