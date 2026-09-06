export function login() {
  return (req: any, res: any) => {
    const email = req.body.email;
    query(`SELECT * FROM Users WHERE email = '${email}'`);
  };
}

export function query(sql: string) {
  return sql;
}

const app: any = {};
app.get("/health", (req: any, res: any) => {
  res.send(req.query.probe);
});

const named = () => 1;

export function outer() {
  return () => () => named();
}

function initializedCallback(): void {
  query("initialized");
}

function assignedCallback(): void {
  query("assigned");
}

export class CallbackHolder {
  private callback = initializedCallback;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  run(): void {
    this.callback();
  }
}

export function invokeHolder(): void {
  new CallbackHolder(assignedCallback).run();
}

export class ParameterHolder {
  constructor(private callback: () => void) {}

  run(): void {
    this.callback();
  }
}

export class OverloadedHolder {
  private callback: () => void;

  constructor(callback: () => void);
  constructor(callback: () => void) {
    this.callback = callback;
  }

  run(): void {
    this.callback();
  }
}

export function invokeAdditionalHolders(): void {
  new ParameterHolder(assignedCallback).run();
  new OverloadedHolder(assignedCallback).run();
}
