declare namespace logger_d_exports {
  export { getLogger };
}
interface Logger {
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, context?: Record<string, any>): void;
}
declare function getLogger(category: string[]): Logger;
//#endregion
export { getLogger, logger_d_exports };