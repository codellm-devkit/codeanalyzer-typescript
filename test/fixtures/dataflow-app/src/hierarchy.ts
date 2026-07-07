/** A minimal first-party class hierarchy — exercises the Neo4j EXTENDS/IMPLEMENTS projection. */

export interface Shape {
  area(): number;
}

export interface Labeled {
  readonly label: string;
}

export class Rectangle implements Shape {
  constructor(
    protected readonly width: number,
    protected readonly height: number,
  ) {}

  area(): number {
    return this.width * this.height;
  }
}

export class Square extends Rectangle implements Labeled {
  readonly label = "square";

  constructor(side: number) {
    super(side, side);
  }
}
