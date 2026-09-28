import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Minimal macOS menu. Electron's default menu includes "Toggle Developer Tools"; packaged builds
 * must not offer DevTools (they reach the preload's world). The Edit menu keeps copy/paste working.
 */
export function installMenu(isDev: boolean): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    ...(isDev ? [{ role: 'viewMenu' } as MenuItemConstructorOptions] : []),
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
