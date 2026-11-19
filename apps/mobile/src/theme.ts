import { Platform } from 'react-native';

export const colors = {
  ink: '#191818',
  gold: '#805A2C',
  honey: '#E5C795',
  coral: '#FF8562',
  cream: '#FFFAF6',
  creamStrong: '#F3EADE',
  white: '#FFFFFF',
  line: '#DFD7CC',
  muted: '#655F58',
  green: '#2D6B43',
  greenSoft: '#EDF8F1',
  dangerSoft: '#FFF0EF',
} as const;

export const typography = {
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }),
} as const;

export const layout = { page: 18, radius: 18, radiusLarge: 24 } as const;
