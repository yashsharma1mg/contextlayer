import { customType } from "drizzle-orm/pg-core"

/**
 * pgvector column type. Drizzle has no first-class `vector` column across all
 * versions we might land on, so this is a thin customType instead of relying
 * on a specific drizzle-orm release's native support.
 */
export const vector = (dimensions: number) =>
	customType<{ data: number[]; driverData: string }>({
		dataType() {
			return `vector(${dimensions})`
		},
		toDriver(value: number[]): string {
			return `[${value.join(",")}]`
		},
		fromDriver(value: string): number[] {
			return value
				.slice(1, -1)
				.split(",")
				.map((n) => Number.parseFloat(n))
		},
	})
