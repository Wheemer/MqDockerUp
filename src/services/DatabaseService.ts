import logger from "../services/LoggerService";
import fs from "fs";
import path from "path";
const sqlite3 = require('sqlite3').verbose();

export default class DatabaseService {
    private static db: any | null = null;
    private static initPromise: Promise<void> | null = null;

    private static getDatabasePath(): string {
        return process.env.MQDOCKERUP_DATABASE_PATH || path.join(process.cwd(), 'data', 'database.db');
    }

    private static connect(): any {
        if (this.db) {
            return this.db;
        }

        const databasePath = this.getDatabasePath();
        fs.mkdirSync(path.dirname(databasePath), {recursive: true});
        this.db = new sqlite3.Database(databasePath, (err: any) => {
            if (err) {
                logger.error(err.message);
                return;
            }
            logger.info('Connected to the database.');
        });
        return this.db;
    }

    private static async run(statement: string, params: unknown[] = []): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            this.connect().run(statement, params, (err: Error | null) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Initializes the database.
     * Creates the tables if they don't exist.
     */
    static init(): Promise<void> {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = new Promise((resolve, reject) => {
            this.connect().serialize(() => {
                this.connect().run('CREATE TABLE IF NOT EXISTS containers(id TEXT PRIMARY KEY, name TEXT, image TEXT, tag TEXT)', (err: Error | null) => {
                if (err) {
                    logger.error(err.message);
                    reject(err);
                    return;
                }

                this.connect().run('CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, containerId TEXT)', (err: Error | null) => {
                    if (err) {
                        logger.error(err.message);
                        reject(err);
                        return;
                    }

                    this.connect().run('DELETE FROM topics WHERE id NOT IN (SELECT MIN(id) FROM topics GROUP BY topic, containerId)', (err: Error | null) => {
                        if (err) {
                            logger.error(err.message);
                            reject(err);
                            return;
                        }

                        this.connect().run('CREATE UNIQUE INDEX IF NOT EXISTS topics_topic_container_id_idx ON topics(topic, containerId)', (err: Error | null) => {
                            if (err) {
                                logger.error(err.message);
                                reject(err);
                                return;
                            }

                            logger.info('Database initialized successfully');
                            resolve();
                        });
                    });
                });
            });
        });
        });

        return this.initPromise;
    }

    /**
     * Adds a container to the database.
     * @param id The container id
     * @param name The container name
     * @param image The container image
     * @param tag The container tag
     */
    public static async addContainer(id: string, name: string, image: string, tag: string) {
        await this.run('INSERT OR REPLACE INTO containers(id, name, image, tag) VALUES(?, ?, ?, ?)', [id, name, image, tag]);
    }

    /**
     * Adds a topic to the database.
     * @param topic The subscription topic
     * @param containerId The corresponding container id
     */
    public static async addTopic(topic: string, containerId: string) {
        await this.run('INSERT OR IGNORE INTO topics(topic, containerId) VALUES(?, ?)', [topic, containerId]);
    }

    /**
  * Gets all containers from the database.
  * @param callback The callback function to call with the results
  */
    public static async getContainers(callback: Function) {
        await this.init();
        this.connect().all('SELECT * FROM containers', [], (err: any, rows: any) => {
            callback(err, rows);
        });
    }

    /**
     * Gets a container from the database.
     * @param id The container id
     * @param callback The callback function to call with the results
     */
    public static async getContainer(id: string, callback: Function) {
        await this.init();
        this.connect().get('SELECT * FROM containers WHERE id = ?', [id], (err: any, row: any) => {
            callback(err, row);
        });
    }

    /**
     * Gets all topics for a container from the database.
     * @param containerId The container id
     */
    public static async getTopics(containerId: string, callback: Function) {
        await this.init();
        this.connect().all('SELECT * FROM topics WHERE containerId = ?', [containerId], (err: any, rows: any) => {
            callback(err, rows);
        });
    }

    public static async getTopicsForContainer(containerId: string): Promise<{ topic: string }[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            this.connect().all('SELECT topic FROM topics WHERE containerId = ?', [containerId], (err: any, rows: { topic: string }[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    public static async deleteTopic(topic: string, containerId: string) {
        await this.run('DELETE FROM topics WHERE topic = ? AND containerId = ?', [topic, containerId]);
    }


    /**
 * Checks if an container exists in the database.
 * @param id The container id
 * @return Promise<boolean>
 */
    public static containerExists(id: string): Promise<boolean> {
        return this.init().then(() => new Promise((resolve, reject) => {
            this.connect().get('SELECT * FROM containers WHERE id = ?', [id], (err: any, container: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(!!container);
                }
            });
        }));
    }

    /**
     * Deletes a container from the database.
     * @param id The container id
     */
    public static async deleteContainer(id: string) {
        await this.run('DELETE FROM containers WHERE id = ?', [id]);
        await this.run('DELETE FROM topics WHERE containerId = ?', [id]);
    }


    /**
     * Closes the database connection.
     */
    public static async close() {
        if (!this.db) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.db.close((err: any) => {
                if (err) {
                    logger.error(err.message);
                }
                logger.info('Closed the database connection.');
                this.db = null;
                this.initPromise = null;
                resolve();
            });
        });
    }
}
