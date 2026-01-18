import type {
	SchemaDefinition,
	DataModelFromSchemaDefinition,
	TableNamesInDataModel,
	DocumentByName,
	WithOptionalSystemFields,
} from "convex/server";

export type TableNamesFromSchema<Schema extends SchemaDefinition<any, any>> = TableNamesInDataModel<
	DataModelFromSchemaDefinition<Schema>
>;

export type DocFromSchema<
	Schema extends SchemaDefinition<any, any>,
	TableName extends TableNamesFromSchema<Schema>,
> = WithOptionalSystemFields<DocumentByName<DataModelFromSchemaDefinition<Schema>, TableName>>;

/** Extract document type from a LazyCollection instance. */
export type InferDoc<C> = C extends { $docType?: infer T } ? T : never;
