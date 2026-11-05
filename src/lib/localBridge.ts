// Web: no offline mode (expo-sqlite on web needs extra server headers); the login screen hides the option.
const unavailable = async (): Promise<never> => { throw new Error('Offline mode is only available in the phone app'); };
export const localRequest: (method: string, path: string, body?: unknown) => Promise<any> = unavailable;
export const localUpload: (threadId: string, uri: string, name: string, mime: string, id: string) => Promise<any> = unavailable;
export const dumpBackup: () => Promise<string> = unavailable;
export const restoreBackup: (json: string) => Promise<void> = unavailable;
export const localReportRows: (report: string, channel?: string, from?: string, to?: string) => Promise<{ title: string; rows: Record<string, any>[] }> = unavailable;
