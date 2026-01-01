interface Logger {
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, context?: Record<string, any>): void;
}

class ComponentLogger implements Logger {
  constructor(private category: string[]) {}

  private format(level: string, message: string, context?: Record<string, any>): string {
    const prefix = `[${this.category.join(":")}]`;
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    return `${prefix} ${level}: ${message}${contextStr}`;
  }

  debug(message: string, context?: Record<string, any>): void {
    console.log(this.format("DEBUG", message, context));
  }

  info(message: string, context?: Record<string, any>): void {
    console.log(this.format("INFO", message, context));
  }

  warn(message: string, context?: Record<string, any>): void {
    console.warn(this.format("WARN", message, context));
  }

  error(message: string, context?: Record<string, any>): void {
    console.error(this.format("ERROR", message, context));
  }
}

export function getLogger(category: string[]): Logger {
  return new ComponentLogger(["component", ...category]);
}
