/**
 * 普算移动端 · LLM 对话引擎
 * 对应桌面版 backend/chat.py。支持流式输出、function calling 工具调用循环、
 * 子代理（独立上下文并行）、任务自动续跑。
 */
(function (global) {
  'use strict';

  var S = global.PusuanStorage;
  var P = global.PusuanProvider;
  var T = global.PusuanTools;
  var N = global.PusuanNative;

  var AUTO_RESUME_MAX = 3;

  // ══════════════════════════════════════════
  // 系统提示词（对应 backend/system_prompt.md）
  // ══════════════════════════════════════════

  function loadSystemPrompt(convId) {
    var prompt = '';
    try {
      prompt = N.readAsset('app/system_prompt.md') || '';
    } catch (e) { prompt = ''; }
    // 占位符替换
    prompt = prompt.replace(/__WORKSPACE_DIR__/g, '/workspace');
    prompt = prompt.replace(/__KNOWLEDGE_DIR__/g, '/knowledge');
    var settings = S.loadSettings();
    if (settings.knowledge_query_enabled) {
      prompt = prompt.replace(/<!-- KB:START -->/g, '').replace(/<!-- KB:END -->/g, '');
    } else {
      while (prompt.indexOf('<!-- KB:START -->') >= 0 && prompt.indexOf('<!-- KB:END -->') >= 0) {
        var s = prompt.indexOf('<!-- KB:START -->');
        var e = prompt.indexOf('<!-- KB:END -->') + '<!-- KB:END -->'.length;
        prompt = prompt.slice(0, s) + prompt.slice(e);
      }
    }
    if (settings.archive_enabled) {
      prompt = prompt.replace(/<!-- ARCHIVE:START -->/g, '').replace(/<!-- ARCHIVE:END -->/g, '');
    } else {
      while (prompt.indexOf('<!-- ARCHIVE:START -->') >= 0 && prompt.indexOf('<!-- ARCHIVE:END -->') >= 0) {
        var s2 = prompt.indexOf('<!-- ARCHIVE:START -->');
        var e2 = prompt.indexOf('<!-- ARCHIVE:END -->') + '<!-- ARCHIVE:END -->'.length;
        prompt = prompt.slice(0, s2) + prompt.slice(e2);
      }
    }
    return prompt;
  }

  function buildSubagentSystemPrompt(convId) {
    return loadSystemPrompt(convId) +
      '\n\n# 子代理指令\n\n' +
      '你是由当前对话的主代理分发的子代理，必须完全遵守以下约束：\n' +
      '1. 以完成主代理在下方任务中下达的指令为唯一目标，直接执行，不做多余寒暄。\n' +
      '2. 你只能使用 read（查阅文件）与 skill_select（加载技能）两个查阅类工具。\n' +
      '3. 你没有 write、bash 权限，不得尝试编辑文件或执行命令。\n' +
      '4. 你无权再分发任何子代理，不得调用 spawn_subagent。\n' +
      '5. 完成任务后，直接输出最终结果并结束；你的全部上下文将由主代理在结束后读取。\n';
  }

  function buildMessages(convId, modelCfg) {
    var conv = S.getConversation(convId);
    var providerCfg = P.getProvider(modelCfg.provider || '');
    var systemPrompt = loadSystemPrompt(convId);
    return P.buildMessages(conv, systemPrompt, providerCfg);
  }

  function buildPayload(modelCfg, messages, thinkingMode, toolsList, providerCfg) {
    return P.buildPayload(modelCfg, messages, thinkingMode, toolsList, providerCfg);
  }

  // ══════════════════════════════════════════
  // 流式 API 调用（fetch + ReadableStream 解析 SSE）
  // ══════════════════════════════════════════

  function streamApiCall(url, headers, payload, signal, callbacks) {
    // callbacks: {onChunk, onReasoning, onToolCallStart, onLog}
    var fullContent = '';
    var fullReasoning = '';
    var lastUsage = null;
    var reasoningStart = null;
    var reasoningEnd = null;
    var toolCallsAcc = {};
    var startedIndexes = {};

    console.log('[ChatStream] fetch:', url);
    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: signal,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (errBody) {
          throw { fatal: true, statusCode: resp.status, message: P.mapError(resp.status, errBody, null) };
        });
      }
      console.log('[ChatStream] response ok:', resp.status);
      var reader = resp.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';

      function processLine(line) {
        if (!line || line.indexOf('data: ') !== 0) return;
        var dataStr = line.slice(6);
        if (dataStr === '[DONE]') return;
        var data;
        try { data = JSON.parse(dataStr); } catch (e) { return; }
        if (data.usage) lastUsage = data.usage;
        var choices = data.choices;
        if (!choices || !choices.length) return;
        var delta = choices[0].delta || {};
        var rc = delta.reasoning_content || '';
        if (rc) {
          if (reasoningStart === null) reasoningStart = Date.now();
          fullReasoning += rc;
          if (callbacks.onReasoning) callbacks.onReasoning(rc);
        }
        var content = delta.content || '';
        if (content) {
          if (window.__PUSUAN_DEBUG__) console.log('[ChatStream] chunk:', content.slice(0, 50));
          if (reasoningStart !== null && reasoningEnd === null) reasoningEnd = Date.now();
          fullContent += content;
          if (callbacks.onChunk) callbacks.onChunk(content);
        }
        var tcs = delta.tool_calls;
        if (tcs) {
          tcs.forEach(function (tc) {
            var idx = tc.index !== undefined ? tc.index : 0;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            var acc = toolCallsAcc[idx];
            if (tc.id) acc.id = tc.id;
            var fn = tc.function || {};
            if (fn.name) {
              acc.function.name = fn.name;
              if (callbacks.onToolCallStart && !startedIndexes[idx]) {
                startedIndexes[idx] = true;
                callbacks.onToolCallStart(fn.name, idx);
              }
            }
            if (fn.arguments) acc.function.arguments += fn.arguments;
          });
        }
      }

      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            if (buffer.trim()) processLine(buffer.trim());
            return finish();
          }
          buffer += decoder.decode(res.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(processLine);
          return pump();
        }, function (err) {
          // 流被中断（用户取消）：返回已累积内容，不抛异常
          if (signal && signal.aborted) {
            return finish();
          }
          throw err;
        });
      }

      function finish() {
        var rawToolCalls = null;
        var keys = Object.keys(toolCallsAcc).map(Number).sort(function (a, b) { return a - b; });
        if (keys.length) rawToolCalls = keys.map(function (k) { return toolCallsAcc[k]; });
        var reasoningDuration = 0;
        if (reasoningStart !== null) {
          reasoningDuration = ((reasoningEnd || Date.now()) - reasoningStart) / 1000;
        }
        return {
          content: fullContent,
          reasoning: fullReasoning,
          usage: lastUsage,
          toolCalls: rawToolCalls,
          reasoningDuration: reasoningDuration,
        };
      }

      return pump();
    });
  }

  // ══════════════════════════════════════════
  // 子代理
  // ══════════════════════════════════════════

  function formatSubagentResult(result) {
    var lines = ['【子代理 ' + result.id + '】状态: ' + result.status];
    if (result.error) lines.push('错误: ' + result.error);
    var msgs = result.messages || [];
    lines.push('消息数: ' + msgs.length);
    lines.push('──── 完整上下文 ────');
    msgs.forEach(function (m) {
      var role = m.role;
      if (role === 'user') lines.push('[任务/输入] ' + (m.content || ''));
      else if (role === 'assistant') {
        if (m.reasoning) lines.push('[思考] ' + m.reasoning);
        if (m.tool_calls) {
          m.tool_calls.forEach(function (tc) {
            lines.push('[工具调用] ' + tc.function.name + '(' + tc.function.arguments + ')');
          });
        }
        if (m.content) lines.push('[回复] ' + m.content);
      } else if (role === 'tool') {
        try {
          var data = JSON.parse(m.content || '{}');
          lines.push('[工具执行 ' + (data.name || '?') + '] 结果: ' + (data.result || ''));
        } catch (e) {
          lines.push('[工具执行] ' + (m.content || ''));
        }
      }
    });
    if (result.output) {
      lines.push('──── 最终输出 ────');
      lines.push(result.output);
    }
    return lines.join('\n');
  }

  function runSubagent(subId, convId, task, modelConfig, thinkingMode, signal, callbacks) {
    // callbacks: {onLog}
    var onLog = callbacks.onLog;
    return new Promise(function (resolve) {
      S.createSubagent(convId, subId, task);

      var subSys = buildSubagentSystemPrompt(convId);
      var messages = [
        { role: 'system', content: subSys },
        { role: 'user', content: task },
      ];
      var providerCfg = P.getProvider(modelConfig.provider || '');
      var url = (providerCfg.base_url || 'https://api.deepseek.com').replace(/\/$/, '') +
        (providerCfg.chat_endpoint || '/v1/chat/completions');
      var headers = {
        Authorization: 'Bearer ' + (modelConfig.api_key || P.getApiKey(modelConfig.provider || '')),
        'Content-Type': 'application/json',
      };

      function finish(status, extra) {
        var updates = { status: status, finished_at: S.now() };
        for (var k in (extra || {})) updates[k] = extra[k];
        S.updateSubagent(convId, subId, updates);
        var sub = S.getSubagent(convId, subId) || {};
        resolve({
          id: subId, status: status,
          messages: sub.messages || [], output: sub.output || '', error: sub.error,
        });
      }

      function loop() {
        if (signal && signal.aborted) { finish('cancelled'); return; }
        var subTools = T.buildSubagentTools();
        var payload = buildPayload(modelConfig, messages, thinkingMode, subTools, providerCfg);

        streamApiCall(url, headers, payload, signal, {
          onChunk: function () {}, onReasoning: function () {}, onLog: onLog,
        }).then(function (r) {
          if (!r.toolCalls) {
            S.addSubagentMessage(convId, subId, 'assistant', r.content, r.reasoning, r.reasoningDuration);
            finish('done', { output: r.content });
            return;
          }
          S.addSubagentMessage(convId, subId, 'assistant', r.content, r.reasoning, r.reasoningDuration, r.toolCalls);
          messages.push({
            role: 'assistant', content: r.content || null,
            tool_calls: r.toolCalls, reasoning_content: r.reasoning,
          });

          var chain = Promise.resolve();
          r.toolCalls.forEach(function (tc) {
            chain = chain.then(function () {
              var toolName = tc.function.name;
              var toolArgs = {};
              try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { toolArgs = {}; }
              var result = T.executeTool(toolName, toolArgs, convId);
              S.addSubagentMessage(convId, subId, 'tool', JSON.stringify({
                name: toolName, args: toolArgs, result: result, tool_call_id: tc.id,
              }));
              messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
            });
          });
          chain.then(loop);
        }).catch(function (e) {
          if (signal && signal.aborted) { finish('cancelled'); return; }
          var err = e && e.message ? e.message : String(e);
          finish('failed', { error: err });
        });
      }

      loop();
    });
  }

  // ══════════════════════════════════════════
  // 主对话流（对应 chat.py stream_chat）
  // ══════════════════════════════════════════

  function streamChat(opts) {
    // opts: {convId, userMessage, modelConfig, attachment,
    //        thinkingMode, permissionMode, cancelEvent, askUser, onXxx...}
    var convId = opts.convId;
    var userMessage = opts.userMessage || '';
    var modelConfig = opts.modelConfig;
    var thinkingMode = opts.thinkingMode || 'high';
    var permissionMode = opts.permissionMode || 'ask';
    var cancelEvent = opts.cancelEvent; // {aborted: bool}
    var onChunk = opts.onChunk || function () {};
    var onReasoning = opts.onReasoning || function () {};
    var onToolCall = opts.onToolCall || function () {};
    var onToolResult = opts.onToolResult || function () {};
    var onToolCallStart = opts.onToolCallStart || function () {};
    var onSubagentDone = opts.onSubagentDone || function () {};
    var onLog = opts.onLog || function () {};
    var onApiError = opts.onApiError || function () {};
    var onUsage = opts.onUsage || function () {};
    var onTaskCard = opts.onTaskCard || function () {};
    var onDone = opts.onDone || function () {};
    var persistUser = opts.persistUser !== false;
    var askUser = opts.askUser || null;

    // 附件
    var attachmentsList = [];
    if (opts.attachment) {
      var paths = opts.attachment.split('\n').map(function (p) { return p.trim(); }).filter(Boolean);
      if (paths.length) {
        var pathList = paths.map(function (p) { return '- ' + p; }).join('\n');
        userMessage = userMessage.trim()
          ? '【附件路径】\n' + pathList + '\n\n' + userMessage
          : '【附件路径】\n' + pathList;
        paths.forEach(function (p) {
          attachmentsList.push({ path: p, name: p.split('/').pop(), size: null });
        });
      }
    }

    // 修复历史断链：ask 挂起/中断会导致 assistant(tool_calls) 后缺 tool 响应，
    // 重建历史时 DeepSeek 400；请求前兜底修复当前对话（幂等，无断链零开销）。
    S.repairBrokenToolChains(convId);

        // 保存用户消息（persistUser=false 时只进请求消息，不落盘）
    if (persistUser) {
      S.addMessage(convId, 'user', userMessage, '', 0, 0, undefined, attachmentsList.length ? attachmentsList : undefined);
    }

    // 组装消息
    var messages = buildMessages(convId, modelConfig);
    if (!persistUser && userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    // 当前时间注入
    if (S.loadSettings().time_inject_enabled) {
      var now = new Date();
      var week = '日一二三四五六'[now.getDay()];
      function p2(n) { return (n < 10 ? '0' : '') + n; }
      var timeText = now.getFullYear() + '年' + p2(now.getMonth() + 1) + '月' + p2(now.getDate()) + '日 ' +
        p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds()) + ' 星期' + week;
      messages.push({ role: 'user', content: '【程序注入·当前时间】' + timeText + '（本地时间）' });
    }

    var taskCompleted = false;
    var skillLoaded = null;
    var autoResumeCount = 0;

    var providerCfg = P.getProvider(modelConfig.provider || '');
    var url = (providerCfg.base_url || 'https://api.deepseek.com').replace(/\/$/, '') +
      (providerCfg.chat_endpoint || '/v1/chat/completions');
    var headers = {
      Authorization: 'Bearer ' + (modelConfig.api_key || P.getApiKey(modelConfig.provider || '')),
      'Content-Type': 'application/json',
    };
    var abortCtrl = null;
    if (opts.onStreamReady) opts.onStreamReady(function () { return abortCtrl; });

    function loop() {
      if (cancelEvent && cancelEvent.aborted) { console.log('[DoneTrace] cancel-abort onDone'); onDone(); return; }
      var payload = buildPayload(modelConfig, messages, thinkingMode, T.buildTools(), providerCfg);
      abortCtrl = new AbortController();
      var signal = cancelEvent && cancelEvent.signal ? cancelEvent.signal : abortCtrl.signal;

      streamApiCall(url, headers, payload, signal, {
        onChunk: onChunk,
        onReasoning: onReasoning,
        onToolCallStart: onToolCallStart,
        onLog: onLog,
      }).then(function (r) {
        // usage 统计
        if (r.usage) {
          var pt = r.usage.prompt_tokens || 0;
          var hit = 0;
          if (providerCfg.supports_cache_stats) {
            hit = r.usage.prompt_cache_hit_tokens;
            if (hit === undefined || hit === null) {
              hit = (r.usage.prompt_tokens_details || {}).cached_tokens || 0;
            }
          }
          var stats = S.updateUsageStats(convId, pt, hit);
          onUsage(pt, stats.cache_stats || {});
        }

        if (!r.toolCalls) {
          if (r.content || r.reasoning) {
            S.addMessage(convId, 'assistant', r.content, r.reasoning,
              r.usage ? (r.usage.prompt_tokens || 0) : 0, r.reasoningDuration);
          }
          // 任务自动续跑
          var pending = S.listTasks(convId).filter(function (t) {
            return t.status !== '已完成' && t.status !== '废弃';
          });
          if (!(cancelEvent && cancelEvent.aborted) && pending.length && autoResumeCount < AUTO_RESUME_MAX) {
            autoResumeCount++;
            messages.push({ role: 'user', content: '请继续运行，直至任务清单完成。' });
            loop();
          } else {
            console.log('[DoneTrace] normal onDone');
            onDone();
          }
          return;
        }

        // 有工具调用
        S.addMessage(convId, 'assistant', r.content, r.reasoning, 0, r.reasoningDuration, r.toolCalls);
        var assistantMsg = {
          role: 'assistant', content: r.content || null,
          tool_calls: r.toolCalls, reasoning_content: r.reasoning,
        };
        messages.push(assistantMsg);

        // 权限确认
        var approvals = r.toolCalls.map(function (tc) {
          var toolName = tc.function.name;
          var toolArgs = {};
          try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { toolArgs = {}; }
          if (permissionMode === 'ask' && opts.confirmTool) {
            return opts.confirmTool(convId, toolName, toolArgs);
          }
          return Promise.resolve(true);
        });

        Promise.all(approvals).then(function (approvalList) {
          function processTool(i, tc, approved) {
            if (cancelEvent && cancelEvent.aborted) return Promise.resolve();
            var toolName = tc.function.name;
            var toolArgs = {};
            try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { toolArgs = {}; }

            if (!approved) {
              var denied = '用户拒绝了 ' + toolName + ' 工具调用。';
              S.addMessage(convId, 'tool', JSON.stringify({
                name: toolName, args: toolArgs, result: denied, tool_call_id: tc.id,
              }));
              messages.push({ role: 'tool', tool_call_id: tc.id, content: denied });
              return Promise.resolve();
            }

            onToolCall(toolName, JSON.stringify(toolArgs), i);

            var p;
            if (toolName === 'spawn_subagent') {
              var subId = 'sub_' + S.uid8();
              p = runSubagent(subId, convId, toolArgs.task || '', modelConfig, thinkingMode, signal, { onLog: onLog })
                .then(function (result) {
                  onSubagentDone(i, result.status === 'done');
                  return formatSubagentResult(result);
                });
            } else if (toolName === 'task') {
              p = Promise.resolve().then(function () {
                var r2 = T.executeTask(toolArgs.action, toolArgs, convId);
                if (r2.done) taskCompleted = true;
                var card = buildTaskCard(convId);
                if (card !== null) {
                  S.upsertTaskCard(convId, JSON.stringify(card));
                  onTaskCard(card);
                }
                return r2.result;
              });
            } else if (toolName === 'ask') {
              if (askUser) {
                p = askUser(convId, toolArgs);
              } else {
                p = Promise.resolve('错误: ask 需要交互回调。');
              }
            } else if (toolName === 'knowledge_query') {
              p = Promise.resolve(T.knowledgeQuery(toolArgs));
            } else {
              p = Promise.race([
                Promise.resolve().then(function () {
                  return T.executeTool(toolName, toolArgs, convId);
                }),
                new Promise(function (resolve) {
                  setTimeout(function () {
                    resolve('错误: 工具执行超时（30 秒），已中断。');
                  }, 30000);
                }),
              ]);
            }

            return p.then(function (result) {
              onToolResult(toolName, result, i);
              S.addMessage(convId, 'tool', JSON.stringify({
                name: toolName, args: toolArgs, result: result, tool_call_id: tc.id,
              }));
              messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
              if (toolName === 'skill_select' && result.indexOf('技能已加载') >= 0) {
                skillLoaded = (toolArgs.skill_name || '').trim();
              }
            });
          }

          // 调度：非 spawn 顺序执行，spawn 并行
          var spawnIndexes = [];
          var nonSpawnIndexes = [];
          r.toolCalls.forEach(function (tc, i) {
            if (tc.function.name === 'spawn_subagent') spawnIndexes.push(i);
            else nonSpawnIndexes.push(i);
          });

          var chain = Promise.resolve();
          nonSpawnIndexes.forEach(function (i) {
            chain = chain.then(function () {
              if (taskCompleted) return;
              if (cancelEvent && cancelEvent.aborted) { onDone(); return; }
              return processTool(i, r.toolCalls[i], approvalList[i]);
            });
          });

          var spawnChain = spawnIndexes.length
            ? Promise.all(spawnIndexes.map(function (i) {
                if (cancelEvent && cancelEvent.aborted) { onDone(); return Promise.resolve(); }
                return processTool(i, r.toolCalls[i], approvalList[i]);
              }))
            : Promise.resolve();

          Promise.all([chain, spawnChain]).then(function () {
            if (taskCompleted) { console.log('[DoneTrace] task-complete onDone'); onDone(); return; }
            if (cancelEvent && cancelEvent.aborted) { onDone(); return; }
            if (skillLoaded) {
              messages.push({ role: 'user', content:
                '【任务系统】技能「' + skillLoaded + '」已加载。请立即调用 task 工具' +
                '（action=create, source=skill）创建任务清单：' +
                '将技能内的执行流程/流程步骤提取为清单步骤（直接沿用，不做改写）；' +
                '若技能内没有明确的流程步骤，则按技能内容自行规划步骤。' +
                '创建任务清单后再开始执行技能步骤。'
              });
              skillLoaded = null;
            }
            loop();
          });
        });
      }).catch(function (e) {
        if (cancelEvent && cancelEvent.aborted) { onDone(); return; }
        var code = e && e.statusCode !== undefined ? e.statusCode : null;
        var message = e && e.message ? e.message : String(e);
        handleApiError(convId, code, message, onApiError);
        onDone(); // 错误也结束流（前端清理光标与停止按钮）
      });
    }

    loop();
  }

  function handleApiError(convId, code, message, onApiError) {
    S.addMessage(convId, 'error', JSON.stringify({ code: code, message: message, confirmed: false }));
    var conv = S.getConversation(convId);
    var msgId = '';
    if (conv && conv.messages && conv.messages.length) {
      msgId = conv.messages[conv.messages.length - 1].id || '';
    }
    onApiError(code, message, msgId);
  }

  function buildTaskCard(convId) {
    var tasks = S.listTasks(convId);
    if (!tasks.length) return null;
    var t = tasks[tasks.length - 1];
    return {
      id: t.id, status: t.status, source: t.source,
      steps: (t.steps || []).map(function (s) {
        return { index: s.index, name: s.name, status: s.status };
      }),
    };
  }

  var api = {
    streamChat: streamChat,
    loadSystemPrompt: loadSystemPrompt,
    buildTaskCard: buildTaskCard,
    streamApiCall: streamApiCall,
    runSubagent: runSubagent,
  };

  global.PusuanChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
