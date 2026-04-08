import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  FlatList,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { useNavigation, NavigationProp } from '@react-navigation/native';
import { useAppStore, ExtractedStream } from '../context/appStore';
import { INJECTED_JS, EARLY_HOOKS_JS } from '../services/extraction/injectedScript';

type RootTabs = { Browser: undefined; Devices: undefined; NowPlaying: undefined };

/**
 * Known ad / tracking domains to block at the navigation level.
 * This prevents the WebView from even loading these URLs.
 */
/** Stream URL pattern for sniffing requests at the navigation level. */
const STREAM_SNIFF = /\.(m3u8|mp4|mpd)(\?|$|#)/i;

const AD_BLOCK_PATTERNS = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /popads\.net/i,
  /popcash\.net/i,
  /adnxs\.com/i,
  /propellerads\.com/i,
  /exoclick\.com/i,
  /juicyads\.com/i,
  /trafficjunky\.net/i,
  /clickadu\.com/i,
  /hilltopads\.com/i,
  /pushhouse\.io/i,
  /adsrv\./i,
  /popunder\./i,
  /\.ads\./i,
];

export default function BrowserScreen() {
  const webViewRef = useRef<WebView>(null);
  const [url, setUrl] = useState('https://www.google.com');
  const [inputUrl, setInputUrl] = useState('https://www.google.com');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [iframeUrls, setIframeUrls] = useState<string[]>([]);
  const [refererHeader, setRefererHeader] = useState<string | null>(null);

  const navigation = useNavigation<NavigationProp<RootTabs>>();
  const { extractedStreams, addStream, selectStream, clearStreams, selectedDevice } = useAppStore();

  const normalizeUrl = (input: string): string => {
    let trimmed = input.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      if (/\.\w{2,}/.test(trimmed)) {
        trimmed = 'https://' + trimmed;
      } else {
        trimmed = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
      }
    }
    return trimmed;
  };

  const handleGo = () => {
    const normalized = normalizeUrl(inputUrl);
    setRefererHeader(null);
    setUrl(normalized);
    setInputUrl(normalized);
    setIframeUrls([]);
  };

  const handleRefresh = () => {
    webViewRef.current?.reload();
  };

  const handleNavigationChange = (navState: WebViewNavigation) => {
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    if (navState.url) setInputUrl(navState.url);
    if (navState.title) setPageTitle(navState.title);
  };

  /**
   * Block navigation to known ad domains before the request is sent.
   */
  const handleShouldStartLoad = useCallback((request: ShouldStartLoadRequest): boolean => {
    const requestUrl = request.url;

    // Sniff stream URLs from ALL requests (top-frame + sub-frame navigations)
    if (STREAM_SNIFF.test(requestUrl) && /^https?:\/\//i.test(requestUrl)) {
      const clean = requestUrl.split('#')[0];
      const streamType = /\.m3u8/i.test(clean) ? 'm3u8' : /\.mp4/i.test(clean) ? 'mp4' : 'unknown';
      addStream({
        url: clean,
        type: streamType as ExtractedStream['type'],
        timestamp: Date.now(),
        pageUrl: url,
      });
      console.log('[WebView] Stream sniffed from request:', clean);
    }

    // Always allow the main page navigation
    if (request.isTopFrame) {
      // But still block known ad redirect domains
      for (const pattern of AD_BLOCK_PATTERNS) {
        if (pattern.test(requestUrl)) {
          console.log('[WebView] Blocked top-frame ad redirect:', requestUrl);
          return false;
        }
      }
      return true;
    }

    // Block sub-resource requests to ad domains
    for (const pattern of AD_BLOCK_PATTERNS) {
      if (pattern.test(requestUrl)) {
        console.log('[WebView] Blocked sub-resource ad:', requestUrl.substring(0, 80));
        return false;
      }
    }

    return true;
  }, [url, addStream]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        if (data.type === 'STREAM_FOUND') {
          const streamUrl: string = data.url;
          if (!/^https?:\/\//i.test(streamUrl)) {
            console.log('[Browser] Ignoring non-http stream:', streamUrl);
            return;
          }

          let streamType: ExtractedStream['type'] = 'unknown';
          if (/\.m3u8/i.test(streamUrl)) streamType = 'm3u8';
          else if (/\.mp4/i.test(streamUrl)) streamType = 'mp4';

          const stream: ExtractedStream = {
            url: streamUrl,
            type: streamType,
            timestamp: Date.now(),
            pageUrl: url,
          };
          addStream(stream);
          console.log(`[Browser] Stream captured (${streamType}) via ${data.source}:`, streamUrl);
        }

        if (data.type === 'IFRAME_FOUND') {
          const iframeUrl: string = data.url;
          console.log(`[Browser] Iframe found: ${iframeUrl} (${data.width}x${data.height})`);
          setIframeUrls((prev) => {
            if (prev.includes(iframeUrl)) return prev;
            return [...prev, iframeUrl];
          });
        }

        if (data.type === 'PLAYER_DETECTED') {
          console.log('[Browser] Player detected:', data.detail);
        }

        if (data.type === 'AD_BLOCKED') {
          console.log('[Browser] Ad blocked:', data.detail);
        }
      } catch {
        // Non-JSON message — ignore
      }
    },
    [url, addStream]
  );

  const handleSelectStream = (stream: ExtractedStream) => {
    selectStream(stream);
    Alert.alert(
      'Stream Selected',
      `Type: ${stream.type.toUpperCase()}\n\n${stream.url.substring(0, 120)}${stream.url.length > 120 ? '...' : ''}`,
      [
        { text: 'OK' },
        {
          text: selectedDevice?.controlURL ? '📡 Cast Now' : '🎬 Go to Cast',
          onPress: () => navigation.navigate('NowPlaying'),
        },
      ]
    );
  };

  const handleClearStreams = () => {
    Alert.alert('Clear Streams', 'Remove all found streams?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: clearStreams },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* URL Bar */}
      <View style={styles.urlBar}>
        <TouchableOpacity
          style={[styles.navBtn, !canGoBack && styles.navBtnDisabled]}
          onPress={() => webViewRef.current?.goBack()}
          disabled={!canGoBack}
        >
          <Text style={styles.navBtnText}>{'‹'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navBtn, !canGoForward && styles.navBtnDisabled]}
          onPress={() => webViewRef.current?.goForward()}
          disabled={!canGoForward}
        >
          <Text style={styles.navBtnText}>{'›'}</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.urlInput}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={handleGo}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          placeholder="Enter URL or search..."
          placeholderTextColor="#666"
          selectTextOnFocus
        />
        <TouchableOpacity style={styles.goBtn} onPress={handleGo}>
          <Text style={styles.goBtnText}>Go</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.refreshBtn} onPress={handleRefresh}>
          <Text style={styles.refreshBtnText}>↻</Text>
        </TouchableOpacity>
      </View>

      {/* Loading indicator */}
      {isLoading && (
        <View style={styles.loadingBar}>
          <ActivityIndicator size="small" color="#00d4ff" />
          <Text style={styles.loadingText} numberOfLines={1}>
            {pageTitle || 'Loading...'}
          </Text>
        </View>
      )}

      {/* WebView */}
      <WebView
        ref={webViewRef}
        source={
          refererHeader
            ? { uri: url, headers: { Referer: refererHeader } }
            : { uri: url }
        }
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        injectedJavaScript={INJECTED_JS}
        injectedJavaScriptBeforeContentLoaded={EARLY_HOOKS_JS}
        injectedJavaScriptForMainFrameOnly={true}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigationChange}
        onLoadStart={() => setIsLoading(true)}
        onLoadEnd={() => setIsLoading(false)}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        onError={(syntheticEvent) => {
          console.log('[WebView] Error:', syntheticEvent.nativeEvent);
          setIsLoading(false);
        }}
        onHttpError={(syntheticEvent) => {
          console.log('[WebView] HTTP Error:', syntheticEvent.nativeEvent.statusCode);
        }}
        // Block new window popups (Android)
        setSupportMultipleWindows={false}
        // Allow iframes to load (critical for embedded players)
        allowsFullscreenVideo
        // User agent: pretend to be a desktop browser for better player compat
        userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        // Allow mixed content (some streams are http on https pages)
        mixedContentMode="compatibility"
        // Cache & cookies for login persistence
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
      />

      {/* Embedded Player Frames — navigate into them to extract streams */}
      {iframeUrls.length > 0 && extractedStreams.length === 0 && (
        <View style={styles.iframeBar}>
          <Text style={styles.iframeTitle}>🎬 Embedded players detected — tap to open:</Text>
          <FlatList
            data={iframeUrls}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item}
            renderItem={({ item }) => {
              let label = 'Player';
              try {
                const host = new URL(item).hostname.replace('www.', '');
                label = host;
              } catch { /* */ }
              return (
                <TouchableOpacity
                  style={styles.iframeChip}
                  onPress={() => {
                    console.log('[Browser] Navigating into iframe:', item, 'with Referer:', url);
                    setRefererHeader(url);
                    setUrl(item);
                    setInputUrl(item);
                    setIframeUrls([]);
                  }}
                >
                  <Text style={styles.iframeChipText}>▶ {label}</Text>
                  <Text style={styles.iframeChipUrl} numberOfLines={1}>
                    {item.substring(0, 60)}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>
      )}

      {/* Extracted Streams Bar */}
      {extractedStreams.length > 0 && (
        <View style={styles.streamsBar}>
          <View style={styles.streamsHeader}>
            <Text style={styles.streamsTitle}>
              🔗 Found Streams ({extractedStreams.length})
            </Text>
            <TouchableOpacity onPress={handleClearStreams}>
              <Text style={styles.clearBtn}>Clear</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={extractedStreams}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.url}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.streamChip,
                  item.type === 'm3u8' && styles.streamChipHls,
                  item.type === 'mp4' && styles.streamChipMp4,
                ]}
                onPress={() => handleSelectStream(item)}
              >
                <Text style={styles.streamChipType}>
                  {item.type === 'm3u8' ? '🎞 HLS' : item.type === 'mp4' ? '🎬 MP4' : '📦 STREAM'}
                </Text>
                <Text style={styles.streamChipUrl} numberOfLines={2}>
                  {item.url.replace(/https?:\/\//, '').substring(0, 60)}
                </Text>
                <Text style={styles.streamChipTime}>
                  {new Date(item.timestamp).toLocaleTimeString()}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
  },
  urlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    backgroundColor: '#1a1a2e',
    gap: 6,
  },
  navBtn: {
    width: 32,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#2a2a4a',
    borderRadius: 6,
  },
  navBtnDisabled: {
    opacity: 0.3,
  },
  navBtnText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  urlInput: {
    flex: 1,
    height: 36,
    backgroundColor: '#2a2a4a',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#e0e0e0',
    fontSize: 14,
  },
  goBtn: {
    paddingHorizontal: 14,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#00d4ff',
    borderRadius: 8,
  },
  goBtnText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#2a2a4a',
    borderRadius: 6,
  },
  refreshBtnText: {
    color: '#00d4ff',
    fontSize: 20,
  },
  loadingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#12122a',
    gap: 8,
  },
  loadingText: {
    color: '#888',
    fontSize: 12,
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  streamsBar: {
    backgroundColor: '#1a1a2e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#333',
    maxHeight: 130,
  },
  streamsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  streamsTitle: {
    color: '#00d4ff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  iframeBar: {
    backgroundColor: '#1a2a1a',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a4a2a',
  },
  iframeTitle: {
    color: '#4caf50',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  iframeChip: {
    backgroundColor: '#2a4a2a',
    borderRadius: 10,
    padding: 10,
    marginRight: 10,
    minWidth: 150,
    maxWidth: 260,
    borderLeftWidth: 3,
    borderLeftColor: '#4caf50',
  },
  iframeChipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  iframeChipUrl: {
    color: '#888',
    fontSize: 10,
    marginTop: 3,
  },
  clearBtn: {
    color: '#f44336',
    fontSize: 13,
    fontWeight: 'bold',
  },
  streamChip: {
    backgroundColor: '#2a2a4a',
    borderRadius: 10,
    padding: 10,
    marginRight: 10,
    minWidth: 170,
    maxWidth: 260,
    borderLeftWidth: 3,
    borderLeftColor: '#666',
  },
  streamChipHls: {
    borderLeftColor: '#ff9800',
  },
  streamChipMp4: {
    borderLeftColor: '#4caf50',
  },
  streamChipType: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  streamChipUrl: {
    color: '#aaa',
    fontSize: 11,
    marginTop: 3,
    lineHeight: 15,
  },
  streamChipTime: {
    color: '#555',
    fontSize: 10,
    marginTop: 3,
  },
});
