import _default from "../schema.js";
import { DataModelFromSchemaDefinition, DocumentByName, SystemTableNames, TableNamesInDataModel } from "convex/server";
import { GenericId } from "convex/values";

//#region src/component/_generated/dataModel.d.ts

/**
 * The names of all of your Convex tables.
 */
type TableNames = TableNamesInDataModel<DataModel>;
/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */
type DataModel = DataModelFromSchemaDefinition<typeof _default>;
//#endregion
export { DataModel, Doc, Id, TableNames };