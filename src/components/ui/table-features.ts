import {
    columnFacetingFeature,
    columnFilteringFeature,
    columnOrderingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    createFacetedRowModel,
    createFacetedUniqueValues,
    createFilteredRowModel,
    createPaginatedRowModel,
    createSortedRowModel,
    filterFn_arrIncludes,
    filterFn_equals,
    filterFn_inNumberRange,
    filterFn_includesString,
    filterFn_weakEquals,
    rowPaginationFeature,
    rowSelectionFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    sortFn_datetime,
    sortFn_text,
    tableFeatures,
    type CellContext,
    type Column,
    type ColumnDef,
    type HeaderContext,
    type Row,
    type RowData,
    type Table,
} from "@tanstack/react-table";

/**
 * What every table of DBackup can do, for `DataTable` and the types of its columns. TanStack Table
 * 9 includes only the features and row models a table names: sorting, filtering with the values
 * a faceted filter offers, columns switched off, moved and sized, pages and selected rows.
 *
 * Only the functions registered here resolve a name, `auto` included. These are the ones `auto`
 * picks from for the values the tables hold, the columns with a function of their own need none.
 */
export const appTableFeatures = tableFeatures({
    columnFacetingFeature,
    columnFilteringFeature,
    columnOrderingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    rowPaginationFeature,
    rowSelectionFeature,
    rowSortingFeature,
    filteredRowModel: createFilteredRowModel(),
    sortedRowModel: createSortedRowModel(),
    paginatedRowModel: createPaginatedRowModel(),
    facetedRowModel: createFacetedRowModel(),
    facetedUniqueValues: createFacetedUniqueValues(),
    filterFns: {
        includesString: filterFn_includesString,
        inNumberRange: filterFn_inNumberRange,
        equals: filterFn_equals,
        weakEquals: filterFn_weakEquals,
        arrIncludes: filterFn_arrIncludes,
    },
    sortFns: {
        alphanumeric: sortFn_alphanumeric,
        text: sortFn_text,
        datetime: sortFn_datetime,
        basic: sortFn_basic,
    },
});

/** The features of every table of DBackup, the first parameter of the types of TanStack Table 9. */
export type AppTableFeatures = typeof appTableFeatures;

/** A column of a table of DBackup. */
export type AppColumnDef<TData extends RowData, TValue = unknown> = ColumnDef<AppTableFeatures, TData, TValue>;

/** A row of a table of DBackup. */
export type AppRow<TData extends RowData> = Row<AppTableFeatures, TData>;

/** The column object of a table of DBackup, as a header or a filter gets it. */
export type AppColumn<TData extends RowData, TValue = unknown> = Column<AppTableFeatures, TData, TValue>;

/** A table of DBackup. */
export type AppTable<TData extends RowData> = Table<AppTableFeatures, TData>;

/** What the cell of a column of DBackup gets. */
export type AppCellContext<TData extends RowData, TValue = unknown> = CellContext<AppTableFeatures, TData, TValue>;

/** What the header of a column of DBackup gets. */
export type AppHeaderContext<TData extends RowData, TValue = unknown> = HeaderContext<AppTableFeatures, TData, TValue>;
