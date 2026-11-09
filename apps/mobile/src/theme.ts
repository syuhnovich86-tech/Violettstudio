import { Platform } from 'react-native';

export const colors = {
  ink: '#191818',
  gold: '#C87D27',
  honey: '#F5BE70',
  coral: '#FF8562',
  cream: '#FFFAF6',
  creamStrong: '#FFF1DF',
  white: '#FFFFFF',
  line: '#E7DFD7',
  muted: '#736B65',
  green: '#2D6B43',
  greenSoft: '#EDF8F1',
  dangerSoft: '#FFF0EF',
} as const;

export const typography = {
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }),
} as const;

export const layout = { page: 18, radius: 18, radiusLarge: 24 } as const;
