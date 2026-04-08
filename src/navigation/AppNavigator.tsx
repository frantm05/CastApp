import React from 'react';
import { View, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator, BottomTabBar } from '@react-navigation/bottom-tabs';
import BrowserScreen from '../screens/BrowserScreen';
import DevicesScreen from '../screens/DevicesScreen';
import NowPlayingScreen from '../screens/NowPlayingScreen';
import CastingMiniBar from '../components/CastingMiniBar';
import { useAppStore } from '../context/appStore';

export type RootTabParamList = {
  Browser: undefined;
  Devices: undefined;
  NowPlaying: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Browser: '🌐',
    Devices: '📺',
    NowPlaying: '🎬',
  };
  return (
    <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>
      {icons[label] || '•'}
    </Text>
  );
}

export default function AppNavigator() {
  const { isCasting, castingStatus } = useAppStore();
  const showCastBadge = isCasting && castingStatus !== 'idle' && castingStatus !== 'stopped';

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerStyle: { backgroundColor: '#1a1a2e' },
          headerTintColor: '#e0e0e0',
          tabBarStyle: { backgroundColor: '#1a1a2e', borderTopColor: '#333' },
          tabBarActiveTintColor: '#00d4ff',
          tabBarInactiveTintColor: '#888',
          tabBarIcon: ({ focused }) => (
            <TabIcon label={route.name} focused={focused} />
          ),
        })}
        tabBar={(props) => (
          <View>
            <CastingMiniBar />
            <BottomTabBar {...props} />
          </View>
        )}
      >
        <Tab.Screen
          name="Browser"
          component={BrowserScreen}
          options={{ title: 'Browser' }}
        />
        <Tab.Screen
          name="Devices"
          component={DevicesScreen}
          options={{ title: 'Devices' }}
        />
        <Tab.Screen
          name="NowPlaying"
          component={NowPlayingScreen}
          options={{
            title: 'Now Playing',
            tabBarBadge: showCastBadge ? '' : undefined,
            tabBarBadgeStyle: {
              backgroundColor:
                castingStatus === 'playing'
                  ? '#4caf50'
                  : castingStatus === 'error'
                    ? '#f44336'
                    : '#ff9800',
              minWidth: 10,
              maxHeight: 10,
              borderRadius: 5,
              top: 2,
            },
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
