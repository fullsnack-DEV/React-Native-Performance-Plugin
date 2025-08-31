declare module '@rozenite/plugin-bridge' {
  export type RemoveListener = { remove(): void };
  export type DevToolsPluginClient<TEvents> = {
    send: <K extends keyof TEvents & string>(event: K, payload: TEvents[K]) => void;
    onMessage: <K extends keyof TEvents & string>(event: K, cb: (payload: TEvents[K]) => void) => RemoveListener;
    close(): void;
  };
  export function useRozeniteDevToolsClient<TEvents>(options: { pluginId: string }): DevToolsPluginClient<TEvents> | null;
}


