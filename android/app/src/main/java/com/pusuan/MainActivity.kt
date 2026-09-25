package com.pusuan

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pusuan.engine.EngineManager
import com.pusuan.engine.EngineService
import com.pusuan.ui.ChatViewModel
import com.pusuan.ui.theme.PusuanTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 引擎交给前台服务拉起，界面只做呈现与交互
        EngineService.start(this)

        setContent {
            PusuanTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppRoot()
                }
            }
        }
    }
}

@Composable
private fun AppRoot() {
    val vm = remember { ChatViewModel() }
    val engineState by PusuanApp.engine.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = { TopBar(engineState) }
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            when (val st = engineState) {
                is EngineManager.EngineState.Running -> {
                    // 引擎就绪后才连内核：建客户端、开会话、订阅事件流。
                    // onEngineReady 内部幂等，重组不会重复建会话。
                    LaunchedEffect(st.port) { vm.onEngineReady(st.port) }
                    ChatScreen(vm)
                }
                is EngineManager.EngineState.Failed -> CenterMessage("引擎启动失败\n\n${st.message}")
                else -> StartupView(engineState)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TopBar(state: EngineManager.EngineState) {
    val subtitle = when (state) {
        is EngineManager.EngineState.Running -> "已就绪"
        is EngineManager.EngineState.Starting -> state.step
        is EngineManager.EngineState.Failed -> "启动失败"
        EngineManager.EngineState.Idle -> "未启动"
    }
    TopAppBar(
        title = {
            Column {
                Text("普算", fontWeight = FontWeight.SemiBold)
                Text(subtitle, style = MaterialTheme.typography.labelSmall)
            }
        }
    )
}

@Composable
private fun StartupView(state: EngineManager.EngineState) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        val step = (state as? EngineManager.EngineState.Starting)?.step ?: "准备中…"
        Text(step)
        Spacer(Modifier.height(8.dp))
        Text(
            "首次启动需要解压内核，请稍候",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun CenterMessage(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun ChatScreen(vm: ChatViewModel) {
    val listState = rememberLazyListState()
    var input by remember { mutableStateOf("") }
    val msgs = vm.messages

    LaunchedEffect(vm.sessionReady) {
        if (vm.sessionReady) vm.refreshHistory()
    }
    LaunchedEffect(msgs.size) {
        if (msgs.isNotEmpty()) listState.animateScrollToItem(msgs.lastIndex)
    }

    Column(Modifier.fillMaxSize()) {
        if (!vm.sessionReady) {
            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (vm.status.isBlank()) "创建会话…" else vm.status)
                }
            }
        } else if (vm.status.isNotBlank()) {
            Text(
                vm.status,
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(msgs) { m -> MessageBubble(m.role, m.text, m.streaming) }
        }

        Composer(
            value = input,
            enabled = vm.sessionReady,
            busy = vm.busy,
            onChange = { input = it },
            onSend = {
                val t = input.trim()
                if (t.isNotEmpty()) { vm.send(t); input = "" }
            },
            onStop = { vm.cancel() }
        )
    }
}

@Composable
private fun MessageBubble(role: String, text: String, streaming: Boolean) {
    val isUser = role == "user"
    val bg = if (isUser) MaterialTheme.colorScheme.primaryContainer
    else MaterialTheme.colorScheme.surfaceVariant
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Column(
            Modifier
                .widthIn(max = 320.dp)
                .background(bg, RoundedCornerShape(14.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text(
                if (isUser) "我" else "普算",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium
            )
            Spacer(Modifier.height(2.dp))
            Text(if (text.isEmpty() && streaming) "…" else text)
            if (streaming) {
                Spacer(Modifier.height(4.dp))
                Text("正在输出", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun Composer(
    value: String,
    enabled: Boolean,
    busy: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit
) {
    Row(
        Modifier.fillMaxWidth().imePadding().padding(10.dp),
        verticalAlignment = Alignment.Bottom
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.weight(1f),
            enabled = enabled,
            placeholder = { Text(if (enabled) "问点什么…" else "等待引擎就绪") },
            maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() })
        )
        Spacer(Modifier.width(8.dp))
        if (busy) {
            Button(onClick = onStop) { Text("停止") }
        } else {
            Button(onClick = onSend, enabled = enabled && value.isNotBlank()) { Text("发送") }
        }
    }
}
