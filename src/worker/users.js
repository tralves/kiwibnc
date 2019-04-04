const bcrypt = require('bcrypt');
const uuidv4 = require('uuid/v4');

class Users {
    constructor(db) {
        this.db = db;
    }

    async authUserNetwork(username, password, network) {
        let row = null;
        try {
            row = await this.db.get(`
                SELECT
                    nets.*,
                    users.password as _pass,
                    users.admin as user_admin
                FROM user_networks nets
                INNER JOIN users ON users.id = nets.user_id
                WHERE users.username = ? AND nets.name = ?
            `, [username, network]);
            
            if (row) {
                let correctHash = await bcrypt.compare(password, row._pass);
                if (!correctHash) {
                    row = null;
                } else {
                    // We don't need the password hash going anywhere else, get rid of it
                    delete row._pass;
                }
            }
        } catch (err) {
            l.error('Error logging user in:', err.stack);
        }

        return row;
    }

    async authUser(username, password) {
        let row = await this.db.get(`SELECT * from users WHERE username = ?`, [username]);
        if (row) {
            let correctHash = await bcrypt.compare(password, row.password);
            if (!correctHash) {
                row = null;
            } else {
                // We don't need the password hash going anywhere else, get rid of it
                delete row.password;
            }
        }
        return row;
    }

    async authUserToken(token) {
        let row = await this.db.get(`SELECT * from user_tokens WHERE token = ?`, [token]);
        if (!row) {
            return;
        }

        let user = await this.db.get(`SELECT * from users WHERE id = ?`, [row.user_id]);
        if (!user) {
            return;
        }

        // We don't need the password hash going anywhere else, get rid of it
        delete user.password;
        return user;
    }

    async generateUserToken(id) {
        let token = uuidv4().replace(/\-/g, '');
        await this.db.db('user_tokens').insert({
            user_id: id,
            token: token,
            created_at: Date.now(),
        });
        return token;
    }

    async getUser(username) {
        return await this.db.get(`SELECT * from users WHERE username = ?`, [username]);
    }

    async addUser(username, password) {
        await this.db.db('users').insert({
            username,
            password: await bcrypt.hash(password, 8),
            created_at: Date.now()
        });

        return await this.getUser(username);
    };

    async changeUserPassword(id, password) {
        await this.db.run('UPDATE users SET password = ? WHERE id = ?', [
            await bcrypt.hash(password, 8),
            id,
        ]);
    };

    async getUserNetworks(userId) {
        let rows = await this.db.all('SELECT * FROM user_networks WHERE user_id = ?', [userId]);
        return rows;
    }

    async getNetwork(id) {
        let row = await this.db.get(`SELECT * from user_networks WHERE id = ?`, [id]);
        return row;
    }

    async getNetworkByName(userId, netName) {
        let row = await this.db.get(`SELECT * from user_networks WHERE user_id = ? AND name = ?`, [
            userId,
            netName,
        ]);
        return row;
    }
}

module.exports = Users;