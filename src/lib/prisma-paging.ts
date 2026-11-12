import { Prisma } from '@prisma/client'

/**
 * Prisma on SQLite reads the rows of an ordered relation under a `select` with the ids of every
 * parent in one statement. Prisma 6 split a read of more than 999 parents and panicked merging the
 * parts ("no entry found for key", record.rs), Prisma 7 refuses it once the statement binds more
 * than 999 values (P2029), which a read of 998 parents already does. So a `findMany` that reads
 * 1000 jobs with their ordered destinations or runs fails, which an instance with many tenants
 * reaches in All tenants. `relationOrderPaging` reads such a query in pages of 900 parents instead,
 * which leaves room for the values of filters on the relation, in the order it asked for with the
 * id last, so the pages never overlap.
 */

/** The most parents a read with an ordered relation asks for at once. */
export const RELATION_ORDER_PAGE = 900

type Args = Record<string, unknown>

const isObject = (value: unknown): value is Args => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a read orders the rows of a relation it reads, at any depth. */
export function ordersRelations(args: unknown): boolean {
  if (!isObject(args)) return false
  for (const key of ['select', 'include'] as const) {
    const fields = args[key]
    if (!isObject(fields)) continue
    for (const value of Object.values(fields)) {
      if (!isObject(value)) continue
      if (value.orderBy !== undefined) return true
      if (ordersRelations(value)) return true
    }
  }
  return false
}

/** The order of a read with the id last, so the pages of it are stable. */
function withIdLast(orderBy: unknown): unknown[] {
  const list = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy]
  return list.some((entry) => isObject(entry) && 'id' in entry) ? list : [...list, { id: 'asc' }]
}

/**
 * Runs a `findMany` in pages of `page` parents while it orders a relation and may read more, one
 * statement otherwise. A read with a cursor, `distinct` or a `take` from the end runs as it is.
 */
export async function pagedByParents<T>(args: Args, run: (args: Args) => Promise<T[]>, page = RELATION_ORDER_PAGE): Promise<T[]> {
  const take = typeof args.take === 'number' ? args.take : undefined
  const asIs = !ordersRelations(args) || args.cursor !== undefined || args.distinct !== undefined || (take !== undefined && (take < 0 || take <= page))
  if (asIs) return run(args)

  const orderBy = withIdLast(args.orderBy)
  const rows: T[] = []
  let skip = typeof args.skip === 'number' ? args.skip : 0
  for (;;) {
    const want = take === undefined ? page : Math.min(page, take - rows.length)
    const batch = await run({ ...args, orderBy, skip, take: want })
    rows.push(...batch)
    skip += batch.length
    if (batch.length < want || (take !== undefined && rows.length >= take)) return rows
  }
}

/** The models with a field `id`, the only ones a page can order by it. */
const WITH_ID = new Set(Prisma.dmmf.datamodel.models.filter((model) => model.fields.some((field) => field.name === 'id')).map((model) => model.name))

/** Reads a `findMany` that orders a relation in pages of 900 parents, see the top of this file. */
export const relationOrderPaging = Prisma.defineExtension({
  name: 'relationOrderPaging',
  query: {
    $allModels: {
      async findMany({ model, args, query }) {
        if (!WITH_ID.has(model)) return query(args)
        return pagedByParents(args as Args, (next) => query(next as typeof args) as Promise<unknown[]>)
      },
    },
  },
})
