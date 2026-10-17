/**
 * An exact decimal number: an integer count of units of 10^-scale. Prices,
 * GB-seconds and money are decimals, never floating-point numbers (client-
 * readiness plan, §4; parent §8.3), so a sum never drifts and rounding happens
 * once, where the amount is shown or charged.
 */
export class Decimal {
  static readonly ZERO = new Decimal(0n, 0);

  private constructor(
    private readonly units: bigint,
    private readonly scale: number,
  ) {}

  /** "0.0000166667", "-1.5" or "42": anything else is refused, naming it. */
  static parse(text: string): Decimal {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`"${text}" is not a decimal number`);
    const [, sign, whole, fraction = ''] = match;
    const units = BigInt(whole + fraction);
    return new Decimal(sign ? -units : units, fraction.length);
  }

  static of(value: bigint | number): Decimal {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${value} is not a whole number`);
    return new Decimal(BigInt(value), 0);
  }

  /**
   * numerator ÷ denominator, exactly: the denominator may only have 2 and 5
   * as prime factors, as 1,024,000 MB-ms per GB-s and 10^6 requests do, so
   * the result has a finite decimal form.
   */
  static ratio(numerator: bigint, denominator: bigint): Decimal {
    if (denominator <= 0n) throw new Error(`Cannot divide by ${denominator}`);
    let rest = denominator;
    let twos = 0;
    let fives = 0;
    while (rest % 2n === 0n) {
      rest /= 2n;
      twos++;
    }
    while (rest % 5n === 0n) {
      rest /= 5n;
      fives++;
    }
    if (rest !== 1n) throw new Error(`${numerator}/${denominator} has no finite decimal form`);
    const scale = Math.max(twos, fives);
    return new Decimal((numerator * 10n ** BigInt(scale)) / denominator, scale);
  }

  plus(other: Decimal): Decimal {
    const [a, b, scale] = Decimal.align(this, other);
    return new Decimal(a + b, scale);
  }

  minus(other: Decimal): Decimal {
    return this.plus(other.negated());
  }

  times(other: Decimal): Decimal {
    return new Decimal(this.units * other.units, this.scale + other.scale);
  }

  negated(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  compare(other: Decimal): number {
    const [a, b] = Decimal.align(this, other);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  min(other: Decimal): Decimal {
    return this.compare(other) <= 0 ? this : other;
  }

  max(other: Decimal): Decimal {
    return this.compare(other) >= 0 ? this : other;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  /** To `places` decimals, half away from zero: 0.0005 → 0.001, -0.0005 → -0.001. */
  round(places: number): Decimal {
    if (places >= this.scale) return new Decimal(this.units * 10n ** BigInt(places - this.scale), places);
    const divisor = 10n ** BigInt(this.scale - places);
    const magnitude = this.units < 0n ? -this.units : this.units;
    let kept = magnitude / divisor;
    if ((magnitude % divisor) * 2n >= divisor) kept++;
    return new Decimal(this.units < 0n ? -kept : kept, places);
  }

  /** The exact value, without trailing zeros: "0.75", "-3", "0". */
  toString(): string {
    const text = this.format(this.units, this.scale);
    return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  }

  /** Rounded to `places` decimals, and written with all of them: "8.222", "0.000". */
  toFixed(places: number): string {
    const rounded = this.round(places);
    return this.format(rounded.units, rounded.scale);
  }

  private format(units: bigint, scale: number): string {
    const negative = units < 0n;
    const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, digits.length - scale);
    const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
    // Never "-0.000": a negative amount that rounds to zero has 0n units, and BigInt has no -0.
    return `${negative ? '-' : ''}${whole}${fraction}`;
  }

  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale];
  }
}
