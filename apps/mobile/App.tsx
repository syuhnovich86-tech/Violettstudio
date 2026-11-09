import { NavigationContainer, type Theme } from '@react-navigation/native';
import {
  createBottomTabNavigator,
  type BottomTabBarButtonProps,
} from '@react-navigation/bottom-tabs';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { NavigationIcon } from './src/components/NavigationIcon';
import { UpdateBanner } from './src/components/UpdateBanner';
import { AppChromeProvider } from './src/components/AppChrome';
import { AuthProvider, useAuth } from './src/auth/AuthProvider';
import { canUserImportAndroidLibrary, canUserImportIphoneLibrary } from './src/auth/importAuthorization';
import type { RootTabs } from './src/navigation/types';
import { AddScreen } from './src/screens/AddScreen';
import { CalendarScreen } from './src/screens/CalendarScreen';
import { ChatsScreen } from './src/screens/ChatsScreen';
import { ContentScreen } from './src/screens/ContentScreen';
import { MediaScreen } from './src/screens/MediaScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { colors } from './src/theme';

const Tab = createBottomTabNavigator<RootTabs>();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const theme: Theme = {
  dark: false,
  colors: {
    primary: colors.gold,
    background: colors.cream,
    card: colors.white,
    text: colors.ink,
    border: colors.line,
    notification: colors.coral,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
};

const tabIcons: Record<keyof RootTabs, 'calendar' | 'media' | 'add' | 'content' | 'chats'> = {
  Archive: 'media',
  Visits: 'calendar',
  Add: 'add',
  Content: 'content',
  Chats: 'chats',
};

function CameraTabButton({ onPress, onLongPress, accessibilityState }: BottomTabBarButtonProps) {
  return (
    <Pressable
      accessibilityLabel="Добавить фото или видео"
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.cameraSlot, pressed && styles.pressed]}
    >
      <View style={styles.cameraButton}>
        <NavigationIcon name="add" active size={42} />
      </View>
    </Pressable>
  );
}

function AuthenticatedApp() {
  const { user, loading } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android' || !user) return;
    let stopped = false;
    let unsubscribe: () => void = () => undefined;
    let onResume: ReturnType<typeof AppState.addEventListener> | undefined;
    void import('./src/notifications/androidPush').then((push) => {
      if (stopped) return;
      unsubscribe = push.listenForAndroidPushTokens();
      void push.enableAndroidPush().catch(() => undefined);
      onResume = AppState.addEventListener('change', (state) => {
        if (state === 'active') void push.enableAndroidPush(false).catch(() => undefined);
      });
    });
    return () => { stopped = true; unsubscribe(); onResume?.remove(); };
  }, [user?.id]);
  useEffect(() => {
    if (Platform.OS !== 'android' || !user || !canUserImportAndroidLibrary(user)) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void import('./src/media/androidBackup').then((backup) => {
      if (stopped) return;
      void backup.resumeAndroidBackup(user).catch(() => undefined);
      timer = setInterval(() => { if (AppState.currentState === 'active') void backup.runAndroidBackupIfEnabled().catch(() => undefined); }, 8000);
    });
    return () => { stopped = true; if (timer) clearInterval(timer); };
  }, [user?.id, user?.role, user?.is_active, user?.can_upload_media, user?.can_import_android_photo_library]);
  useEffect(() => {
    if (Platform.OS !== 'ios' || !user || !canUserImportIphoneLibrary(user)) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void import('./src/media/iphoneBackup').then((backup) => {
      if (stopped) return;
      void backup.resumeIphoneBackup(user).catch(() => undefined);
      timer = setInterval(() => { if (AppState.currentState === 'active') void backup.runIphoneBackupIfEnabled().catch(() => undefined); }, 8000);
    });
    return () => { stopped = true; if (timer) clearInterval(timer); };
  }, [user?.id, user?.role, user?.is_active, user?.can_upload_media, user?.can_import_ios_photo_library]);
  if (loading) return <View style={styles.loading}><ActivityIndicator size="large" color={colors.gold} /></View>;
  if (!user) return <LoginScreen />;
  return (
    <NavigationContainer theme={theme}>
      <AppChromeProvider value={{ openProfile: () => setProfileOpen(true) }}>
          <StatusBar style="dark" />
          <Tab.Navigator
            initialRouteName="Visits"
            screenOptions={({ route }) => ({
              headerShown: false,
              tabBarShowLabel: false,
              tabBarStyle: styles.tabBar,
              tabBarItemStyle: styles.tabItem,
              tabBarIcon: ({ focused }) => (
                <NavigationIcon name={tabIcons[route.name]} active={focused} size={29} />
              ),
            })}
          >
            <Tab.Screen name="Archive" component={MediaScreen} options={{ title: 'Архив' }} />
            <Tab.Screen name="Visits" component={CalendarScreen} options={{ title: 'Визиты' }} />
            <Tab.Screen
              name="Add"
              component={AddScreen}
              options={{ tabBarButton: (props) => <CameraTabButton {...props} /> }}
            />
            <Tab.Screen name="Content" component={ContentScreen} />
            <Tab.Screen name="Chats" component={ChatsScreen} />
          </Tab.Navigator>
          <UpdateBanner />
          <Modal visible={profileOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setProfileOpen(false)}>
            <ProfileScreen onClose={() => setProfileOpen(false)} />
          </Modal>
      </AppChromeProvider>
    </NavigationContainer>
  );
}

export default function App() {
  useEffect(() => { focusManager.setFocused(AppState.currentState === 'active'); const subscription = AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active')); return () => subscription.remove(); }, []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  tabBar: {
    height: 82,
    paddingTop: 8,
    paddingBottom: 14,
    borderTopColor: colors.line,
    backgroundColor: colors.white,
  },
  tabItem: { minWidth: 48 },
  cameraSlot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cameraButton: {
    width: 72,
    height: 72,
    marginTop: -34,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.honey,
    borderWidth: 6,
    borderColor: colors.cream,
    shadowColor: colors.gold,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 10,
  },
  pressed: { opacity: 0.72 },
});
