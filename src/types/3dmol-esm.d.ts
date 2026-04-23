declare module '3dmol/build/3Dmol.es6-min.js' {
  export function createViewer(element: HTMLElement, config?: Record<string, unknown>): any;
  export function createViewerGrid(
    element: HTMLElement,
    config?: Record<string, unknown>,
    viewerConfig?: Record<string, unknown>,
  ): any[];
}
