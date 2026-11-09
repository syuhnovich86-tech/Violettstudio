import { createContext, useContext } from 'react';

type Chrome = { openProfile: () => void };
const ChromeContext = createContext<Chrome>({ openProfile: () => undefined });

export const AppChromeProvider = ChromeContext.Provider;
export function useAppChrome() { return useContext(ChromeContext); }
