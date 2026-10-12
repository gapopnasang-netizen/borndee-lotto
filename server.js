const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ฟังก์ชันแตกเลข (3 กลับ, 19 ประตู)
function expandBetNumbers(type, number) {
    let results = [];
    if (type === '3 กลับ' && number.length === 3) {
        let arr = number.split('');
        let perms = [];
        let permute = (subArr, m = []) => {
            if (subArr.length === 0) perms.push(m.join(''));
            for (let i = 0; i < subArr.length; i++) {
                let curr = subArr.slice();
                let next = curr.splice(i, 1);
                permute(curr, m.concat(next));
            }
        };
        permute(arr);
        results = [...new Set(perms)];
    } else if (type === '19 ประตู' && number.length === 1) {
        for (let i = 0; i <= 9; i++) {
            results.push(`${number}${i}`);
            if (`${i}${number}` !== `${number}${i}`) results.push(`${i}${number}`);
        }
        results = [...new Set(results)];
    } else {
        results.push(number);
    }
    return results;
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// API: ดึงข้อมูลภาพรวมระบบทั้งหมด + งบการเงิน Win/Loss
app.get('/api/state', async (req, res) => {
    try {
        const membersRes = await pool.query('SELECT * FROM members ORDER BY id DESC');
        const betsRes = await pool.query('SELECT * FROM bets ORDER BY id DESC LIMIT 50');
        const statusRes = await pool.query('SELECT * FROM lottery_status LIMIT 1');
        const resultsRes = await pool.query('SELECT * FROM lottery_results ORDER BY id DESC LIMIT 5');
        const statsRes = await pool.query(`
            SELECT 
                COALESCE(SUM(total_amount), 0) as total_sales, 
                COALESCE(SUM(payout_amount), 0) as total_payout 
            FROM bets WHERE status != 'ยกเลิก'
        `);

        const stats = statsRes.rows[0];
        const netProfit = parseFloat(stats.total_sales) - parseFloat(stats.total_payout);

        res.json({
            success: true,
            members: membersRes.rows,
            bets: betsRes.rows,
            results: resultsRes.rows,
            lotteryStatus: statusRes.rows[0] || { is_open: true },
            financial: {
                totalSales: parseFloat(stats.total_sales),
                totalPayout: parseFloat(stats.total_payout),
                netProfit: netProfit
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ส่งโพยหวย (พร้อมเช็คเลขอั้น/เลขเต็ม และวงเงินสูงสุด)
app.post('/api/member/bet', async (req, res) => {
    const { memberId, betType, number, amount } = req.body;
    try {
        // เช็คเลขอั้น
        const blockedCheck = await pool.query('SELECT * FROM blocked_numbers WHERE number = $1', [number]);
        if (blockedCheck.rows.length > 0) {
            const rule = blockedCheck.rows[0];
            if (rule.restriction_type === 'ปิดรับ') {
                return res.status(400).json({ success: false, message: `เลข ${number} เป็นเลขเต็ม ปิดรับแทงแล้ว!` });
            }
        }

        // เช็ควงเงินรับแทงสูงสุดต่อเลข
        const maxLimitRes = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'max_bet_per_num'");
        const maxLimit = maxLimitRes.rows.length > 0 ? parseFloat(maxLimitRes.rows[0].setting_value) : 2000;
        if (parseFloat(amount) > maxLimit) {
            return res.status(400).json({ success: false, message: `จำกัดยอดแทงสูงสุดไม่เกิน ${maxLimit.toLocaleString()} ฿ ต่อรายการ` });
        }

        const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
        if (memberRes.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบสมาชิก' });
        
        const member = memberRes.rows[0];
        const expandedNumbers = expandBetNumbers(betType, number);
        let totalAmount = expandedNumbers.length * parseFloat(amount);

        if (parseFloat(member.balance) < totalAmount) {
            return res.status(400).json({ success: false, message: 'ยอดเงินในกระเป๋าไม่พอ' });
        }

        const newBalance = parseFloat(member.balance) - totalAmount;
        await pool.query('UPDATE members SET balance = $1 WHERE id = $2', [newBalance, memberId]);

        let details = expandedNumbers.map(n => ({ number: n, price: parseFloat(amount) }));
        const betInsert = await pool.query(
            'INSERT INTO bets (member_username, bet_type, original_number, total_amount, details, status, time) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
            [member.username, betType, number, totalAmount, JSON.stringify(details), 'รอผลรางวัล']
        );

        res.json({ success: true, bet: betInsert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ดึงข้อมูลหน้าแอดมินทั้งหมด
app.get('/api/admin/all-data', async (req, res) => {
    try {
        const txRes = await pool.query('SELECT * FROM transactions ORDER BY id DESC LIMIT 20');
        const allBetsRes = await pool.query('SELECT * FROM bets ORDER BY id DESC LIMIT 50');
        const agentsRes = await pool.query('SELECT * FROM members WHERE balance > 0 ORDER BY balance DESC');
        const announcementsRes = await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 5');
        const banksRes = await pool.query('SELECT * FROM bank_accounts ORDER BY id DESC');
        const settingsRes = await pool.query('SELECT * FROM system_settings');

        let settingsMap = {};
        settingsRes.rows.forEach(s => settingsMap[s.setting_key] = s.setting_value);

        res.json({
            success: true,
            transactions: txRes.rows,
            allBets: allBetsRes.rows,
            agents: agentsRes.rows,
            announcements: announcementsRes.rows,
            banks: banksRes.rows,
            settings: settingsMap
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: จัดการบัญชีธนาคาร (เพิ่ม/เปิด-ปิด)
app.post('/api/admin/add-bank', async (req, res) => {
    const { bankName, accountNumber, accountName } = req.body;
    try {
        await pool.query(
            'INSERT INTO bank_accounts (bank_name, account_number, account_name) VALUES ($1, $2, $3)',
            [bankName, accountNumber, accountName]
        );
        res.json({ success: true, message: 'เพิ่มบัญชีธนาคารสำเร็จ' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: บันทึกตั้งค่าอัตราจ่าย & วงเงินสูงสุด
app.post('/api/admin/save-settings', async (req, res) => {
    const { rate3d, rate2d, maxBet } = req.body;
    try {
        await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('rate_3d', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1", [rate3d]);
        await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('rate_2d', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1", [rate2d]);
        await pool.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('max_bet_per_num', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1", [maxBet]);
        
        res.json({ success: true, message: 'อัปเดตการตั้งค่าระบบเรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: เปิด-ปิดสถานะรับแทงหวย
app.post('/api/admin/toggle-lottery', async (req, res) => {
    const { isOpen } = req.body;
    try {
        await pool.query('UPDATE lottery_status SET is_open = $1', [isOpen]);
        res.json({ success: true, message: `เปลี่ยนสถานะรับแทงเป็น: ${isOpen ? 'เปิดรับแทง' : 'ปิดรับแทง'}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: จัดการฝาก-ถอน
app.post('/api/admin/handle-tx', async (req, res) => {
    const { txId, action } = req.body;
    try {
        const txRes = await pool.query('SELECT * FROM transactions WHERE id = $1', [txId]);
        if (txRes.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบรายการ' });
        const tx = txRes.rows[0];

        if (action === 'อนุมัติ' && tx.status === 'รออนุมัติ') {
            if (tx.type === 'ฝากเงิน') {
                await pool.query('UPDATE members SET balance = balance + $1 WHERE username = $2', [tx.amount, tx.username]);
            }
            await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['อนุมัติแล้ว', txId]);
        } else {
            await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['ปฏิเสธ', txId]);
        }

        res.json({ success: true, message: 'ดำเนินการสำเร็จ' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ตั้งค่าเลขอั้น
app.post('/api/admin/block-number', async (req, res) => {
    const { number, restrictionType } = req.body;
    try {
        await pool.query('INSERT INTO blocked_numbers (number, restriction_type) VALUES ($1, $2)', [number, restrictionType]);
        res.json({ success: true, message: `ตั้งค่าเลขอั้น ${number} สำเร็จ` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ออกผลรางวัลออโต้
app.post('/api/admin/auto-draw', async (req, res) => {
    try {
        const r4 = Math.floor(1000 + Math.random() * 9000).toString();
        const r3 = r4.slice(1);
        const r2 = r4.slice(2);

        await pool.query(
            'INSERT INTO lottery_results (draw_date, prize_4d, prize_3d, prize_2d) VALUES (NOW(), $1, $2, $3)',
            [r4, r3, r2]
        );

        // ดึงอัตราจ่ายปัจจุบันจากฐานข้อมูล
        const rate3Res = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'rate_3d'");
        const rate2Res = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'rate_2d'");
        const rate3d = rate3Res.rows.length > 0 ? parseFloat(rate3Res.rows[0].setting_value) : 850;
        const rate2d = rate2Res.rows.length > 0 ? parseFloat(rate2Res.rows[0].setting_value) : 90;

        const betsRes = await pool.query("SELECT * FROM bets WHERE status = 'รอผลรางวัล'");
        for (let bet of betsRes.rows) {
            let details = typeof bet.details === 'string' ? JSON.parse(bet.details) : bet.details;
            let won = false;
            let payout = 0;

            details.forEach(d => {
                if (bet.bet_type.includes('3') && d.number === r3) {
                    won = true;
                    payout += d.price * rate3d;
                } else if (bet.bet_type.includes('2') && d.number === r2) {
                    won = true;
                    payout += d.price * rate2d;
                }
            });

            if (won) {
                await pool.query("UPDATE bets SET status = 'ถูกรางวัล', payout_amount = $1 WHERE id = $2", [payout, bet.id]);
                await pool.query("UPDATE members SET balance = balance + $1 WHERE username = $2", [payout, bet.member_username]);
            } else {
                await pool.query("UPDATE bets SET status = 'ไม่ถูกรางวัล', payout_amount = 0 WHERE id = $1", [bet.id]);
            }
        }

        res.json({ success: true, message: `ออกผลรางวัลสำเร็จ! (4 ตัว: ${r4}, 3 ตัว: ${r3}, 2 ตัว: ${r2})` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: แจกคืนยอดเสีย
app.post('/api/admin/give-cashback', async (req, res) => {
    try {
        await pool.query(`
            UPDATE members SET balance = balance + (
                SELECT COALESCE(SUM(total_amount), 0) * 0.05 FROM bets WHERE bets.member_username = members.username AND status = 'ไม่ถูกรางวัล'
            )
        `);
        res.json({ success: true, message: 'แจกคืนยอดเสีย 5% ให้สมาชิกทั้งหมดเรียบร้อยแล้ว!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ประกาศหน้าเว็บ
app.post('/api/admin/announcement', async (req, res) => {
    const { message } = req.body;
    try {
        await pool.query('INSERT INTO announcements (message) VALUES ($1)', [message]);
        res.json({ success: true, message: 'สร้างประกาศสำเร็จ' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: ยกเลิกโพย
app.post('/api/admin/cancel-bet', async (req, res) => {
    const { betId } = req.body;
    try {
        const betRes = await pool.query('SELECT * FROM bets WHERE id = $1', [betId]);
        if (betRes.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบโพย' });
        const bet = betRes.rows[0];

        if (bet.status === 'รอผลรางวัล') {
            await pool.query('UPDATE members SET balance = balance + $1 WHERE username = $2', [bet.total_amount, bet.member_username]);
            await pool.query("UPDATE bets SET status = 'ยกเลิก' WHERE id = $1", [betId]);
            res.json({ success: true, message: 'ยกเลิกโพยและคืนเงินสำเร็จ' });
        } else {
            res.status(400).json({ success: false, message: 'ไม่สามารถยกเลิกโพยที่ออกผลแล้วได้' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// WebSocket Live Chat
io.on('connection', (socket) => {
    socket.on('send_message', (data) => {
        io.emit('receive_message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`borndee Master Production Server running on http://localhost:${PORT}`));