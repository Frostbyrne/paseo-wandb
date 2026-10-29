import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, Text, View } from "react-native";

export function Segmented<Value extends string>({
  theme,
  label,
  value,
  options,
  onChange,
}: {
  theme: PluginTheme;
  label: string;
  value: Value;
  options: { value: Value; label: string }[];
  onChange: (value: Value) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={`${label}: ${option.label}`}
            onPress={() => onChange(option.value)}
            style={{
              paddingVertical: 4,
              paddingHorizontal: 9,
              borderLeftWidth: index === 0 ? 0 : 1,
              borderLeftColor: theme.colors.border,
              backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
            }}
          >
            <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "600" : "400" }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A horizontal slider; press or drag anywhere on the track, or use the accessibility actions. */
export function Slider({
  theme,
  label,
  value,
  min,
  max,
  step,
  width = 120,
  onChange,
}: {
  theme: PluginTheme;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  width?: number;
  onChange: (value: number) => void;
}) {
  const [trackWidth, setTrackWidth] = useState(width);
  const fraction = (value - min) / (max - min);
  const set = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next / step) * step)));
  const fromEvent = (event: GestureResponderEvent) => set(min + (event.nativeEvent.locationX / trackWidth) * (max - min));
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => set(value + (event.nativeEvent.actionName === "increment" ? step : -step))}
      onLayout={(event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={fromEvent}
      onResponderMove={fromEvent}
      onResponderTerminationRequest={() => false}
      style={{ width, height: 22, justifyContent: "center" }}
    >
      {/* Children ignore touches so locationX is always measured against the track. */}
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2 }}>
        <View style={{ width: `${fraction * 100}%`, height: 4, borderRadius: 2, backgroundColor: theme.colors.accent }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: Math.max(0, fraction * trackWidth - 7),
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: theme.colors.accent,
          backgroundColor: theme.colors.surface0,
        }}
      />
    </View>
  );
}

export function Toggle({ theme, label, value, onChange }: { theme: PluginTheme; label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          borderWidth: 1.5,
          borderColor: value ? theme.colors.accent : theme.colors.foregroundMuted,
          backgroundColor: value ? theme.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Text style={{ color: theme.colors.accentForeground, fontSize: 10, lineHeight: 11, fontWeight: "700" }}>✓</Text> : null}
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/** A run's color as a short line, the way the legend and tooltip key lines. */
export function LineKey({ color, width = 12 }: { color: string; width?: number }) {
  return <View style={{ width, height: 3, borderRadius: 1.5, backgroundColor: color }} />;
}

export function Chip({
  theme,
  label,
  selected = false,
  color,
  status,
  onPress,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  selected?: boolean;
  /** The run's chart color, drawn as a line after the label. */
  color?: string | null;
  /** The run's state color, drawn as a dot before the label. */
  status?: string | null;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {status ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status }} /> : null}
      <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
      {color ? <LineKey color={color} /> : null}
    </Pressable>
  );
}

/** A text input that reports changes after typing pauses. */
export function Field({
  theme,
  value,
  placeholder,
  label,
  onChange,
  width,
  delayMs = 350,
}: {
  theme: PluginTheme;
  value: string;
  placeholder: string;
  label: string;
  onChange: (value: string) => void;
  width?: number;
  delayMs?: number;
}) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => latest.current(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, value, delayMs]);
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        width,
        flexGrow: width ? 0 : 1,
        minWidth: 80,
        paddingVertical: 5,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        fontSize: 12,
      }}
    />
  );
}
