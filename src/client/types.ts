/**
 * Type utilities for extracting document types from Convex schemas.
 * These are public API types - docstrings provide essential usage examples.
 */

import type {
	SchemaDefinition,
	DataModelFromSchemaDefinition,
	TableNamesInDataModel,
	DocumentByName,
} from "convex/server";

/** Extract valid table names from a schema definition. */
export type TableNamesFromSchema<Schema extends SchemaDefinition<any, any>> = TableNamesInDataModel<
	DataModelFromSchemaDefinition<Schema>
>;

/** Extract document type from a Convex schema and table name. */
export type DocFromSchema<
	Schema extends SchemaDefinition<any, any>,
	TableName extends TableNamesFromSchema<Schema>,
> = DocumentByName<DataModelFromSchemaDefinition<Schema>, TableName>;

/** Extract document type from a LazyCollection instance. */
export type InferDoc<C> = C extends { $docType?: infer T } ? T : never;
