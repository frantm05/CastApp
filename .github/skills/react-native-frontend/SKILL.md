---
name: react-native-frontend
description: Frontend, UI, and component rules for CastApp. Use when creating or editing screens, components, styles, or navigation.
---

## React Native Frontend — CastApp

### Design system
- **Dark theme only**
- Background: `#0d0d1a` (primary), `#1a1a2e` (cards/surfaces), `#12122a` (bars)
- Accent: `#00d4ff` (cyan — primary action)
- Warning: `#ff9800` (active/loading state)
- Success: `#4caf50`
- Error: `#f44336`
- Text: `#fff` (primary), `#aaa` (secondary), `#666` / `#555` (muted), `#888` (hint)
- Border radius: 6 (small buttons), 8 (inputs), 10–12 (cards)

### Component rules
- All styles via `StyleSheet.create()` — no inline style objects
- TouchableOpacity for ALL interactive elements (not Pressable)
- FlatList for any list (not ScrollView + map)
- KeyboardAvoidingView at screen root when TextInput is present
- Use `gap` (not margin) for spacing between siblings in flex containers
- Icons: emoji only (no icon libraries) — consistent with existing code

### Screen structure
Each screen component:
1. State declarations at top
2. `useAppStore()` destructure
3. Callbacks with `useCallback`
4. `useEffect` hooks
5. `return ( <View style={styles.container}> ... </View> )`
6. `const styles = StyleSheet.create({...})` at bottom

### Navigation
- 3 tabs: Browser (🌐), Devices (📺), NowPlaying (🎬)
- `useNavigation<NavigationProp<RootTabs>>()` for programmatic navigation
- Tab icons are text/emoji (no vector icons)

### CastingMiniBar
- Always visible at bottom of Browser and Devices screens when `isCasting === true`
- Shows current device name + status + Stop button
- Import from `../components/CastingMiniBar`

### Performance rules
- Memoize callbacks with useCallback (dependencies must be exact)
- No anonymous functions in JSX (extract to named callbacks)
- FlatList: always provide `keyExtractor`
- Avoid re-renders: only subscribe to needed Zustand slices