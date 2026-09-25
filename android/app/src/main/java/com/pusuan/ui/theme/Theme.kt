package com.pusuan.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// 术数类应用的配色取向：克制的墨色 + 一点朱砂做强调，避免默认紫。
private val Ink = Color(0xFF1C1B1F)
private val Paper = Color(0xFFFBF8F4)
private val Vermilion = Color(0xFF8C2F26)
private val VermilionLight = Color(0xFFD4685A)
private val InkSoft = Color(0xFF2A2724)

private val LightColors = lightColorScheme(
    primary = Vermilion,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFF6DAD5),
    onPrimaryContainer = Color(0xFF3A0B06),
    background = Paper,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEFE9E2),
    onSurfaceVariant = Color(0xFF4A453F),
)

private val DarkColors = darkColorScheme(
    primary = VermilionLight,
    onPrimary = Color(0xFF2A0603),
    primaryContainer = Color(0xFF5A1A13),
    onPrimaryContainer = Color(0xFFF6DAD5),
    background = Ink,
    onBackground = Color(0xFFE7E1DA),
    surface = Ink,
    onSurface = Color(0xFFE7E1DA),
    surfaceVariant = InkSoft,
    onSurfaceVariant = Color(0xFFCFC7BE),
)

@Composable
fun PusuanTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
