var fs = require('fs');
var c = fs.readFileSync('C:/Users/xiaofeng/Documents/Dev/AgentChat/webui/client/src/stores/chat.ts','utf8');
var tests = [
  ['AgentTurnEntry', c.includes('interface AgentTurnEntry')],
  ['_agentTurns', c.includes('_agentTurns.value')],
  ['wasIdle', c.includes('wasIdle = !turnInProgress')],
  ['onTEnd push', c.includes('.turns.push({ ...')],
  ['TU struct', c.includes('final!.thinking')],
  ['MU struct', c.includes('final!.content += (data.delta')],
  ['ME struct', c.includes('f.tool_calls = data.tool_calls')],
  ['toolStart', c.includes('_addToolToAgentTurn(agentId')],
  ['toolEnd', c.includes('tc.result = data.result')],
  ['_addTool', c.includes('function _addToolToAgentTurn')],
  ['_buildAgent', c.includes('function _buildAgentTurnsForHistory')],
  ['turns map', c.includes('entries.map((entry, entryIdx)')],
  ['history', c.includes('_buildAgentTurnsForHistory(target')],
  ['resume', c.includes("final: { thinking: d.thinking")],
  ['onTS clean', function() {
    var ts = c.indexOf('function onThinkingStart');
    var tu = c.indexOf('function onThinkingUpdate');
    return ts > 0 && tu > ts && !c.substring(ts, tu).includes('entrs = _agentTurns');
  }()]
];
tests.forEach(function(p) { console.log(p[0] + ': ' + p[1]); });
