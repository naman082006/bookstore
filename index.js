
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const nodemailer = require('nodemailer');
const session = require('express-session');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

fs.mkdirSync(path.join(__dirname, 'public/uploads'), { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/uploads'));
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        file.mimetype.startsWith('image/')
            ? cb(null, true)
            : cb(new Error('Only image files are allowed'));
    }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret-before-deployment',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use((req, res, next) => {
    const cart = req.session.cart || {};

    res.locals.cartCount = Object.values(cart).reduce(
        (sum, quantity) => sum + Math.max(0, Number(quantity) || 0),
        0
    );

    res.locals.isAdmin = !!req.session.isAdmin;
    next();
});

const bookSchema = new mongoose.Schema({
    title: String,
    author: String,
    price: Number,
    category: String,
    image: String
});

const orderSchema = new mongoose.Schema({
    items: [{
        bookId: mongoose.Schema.Types.ObjectId,
        title: String,
        price: Number,
        quantity: Number
    }],
    total: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        default: 'Confirmed'
    },
    shipping: {
        name: String,
        phone: String,
        address: String,
        city: String,
        postalCode: String
    },
    sessionId: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Book = mongoose.model('Book', bookSchema);
const Order = mongoose.model('Order', orderSchema);

const transport =
    process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
        ? nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_APP_PASSWORD
            }
        })
        : null;

const orderStatuses = [
    'Confirmed',
    'Processing',
    'Shipped',
    'Delivered',
    'Cancelled'
];

function isAdmin(req, res, next) {
    if (req.session.isAdmin) {
        return next();
    }

    res.redirect('/admin/login');
}

function getCart(req) {
    if (!req.session.cart) {
        req.session.cart = {};
    }

    return req.session.cart;
}

async function getCartItems(req) {
    const cart = getCart(req);
    const items = [];

    for (const [id, quantity] of Object.entries(cart)) {
        if (!mongoose.isValidObjectId(id)) {
            delete cart[id];
            continue;
        }

        const book = await Book.findById(id);

        if (!book || Number(quantity) < 1) {
            delete cart[id];
            continue;
        }

        items.push({
            book,
            quantity: Number(quantity),
            lineTotal: Number(book.price) * Number(quantity)
        });
    }

    return items;
}

function calculateOrderTotal(items) {
    return items.reduce(
        (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
        0
    );
}

/* HOME, ABOUT AND CONTACT */

app.get('/', (req, res) => {
    res.render('home.ejs');
});

app.get('/about', (req, res) => {
    res.render('about.ejs');
});

app.get('/contact', (req, res) => {
    res.render('contact.ejs');
});

/* ADMIN LOGIN AND LOGOUT */

app.get('/admin/login', (req, res) => {
    res.render('adminlogin.ejs');
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (
        username === ADMIN_USERNAME &&
        password === ADMIN_PASSWORD
    ) {
        req.session.isAdmin = true;

        return req.session.save(error => {
            if (error) {
                return res.status(500).send('Unable to start admin session');
            }

            res.redirect('/admin/orders');
        });
    }

    res.status(401).send('Invalid Username or Password');
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

/* ADMIN: VIEW ALL CUSTOMER ORDERS */

app.get('/admin/orders', isAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });

        res.render('adminorders.ejs', {
            orders,
            orderStatuses
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load customer orders');
    }
});

/* ADMIN: OPEN ORDER EDIT PAGE */

app.get('/admin/orders/:id/edit', isAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).send('Order not found');
        }

        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).send('Order not found');
        }

        res.render('admineditorder.ejs', {
            order,
            orderStatuses
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to open order');
    }
});

/* ADMIN: UPDATE ORDER AND BILL */

app.post('/admin/orders/:id/edit', isAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).send('Invalid order ID');
        }

        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).send('Order not found');
        }

        const {
            name,
            phone,
            address,
            city,
            postalCode,
            status
        } = req.body;

        if (
            ![name, phone, address, city, postalCode]
                .every(value => typeof value === 'string' && value.trim())
        ) {
            return res.status(400).send('Please fill in all delivery details');
        }

        if (!orderStatuses.includes(status)) {
            return res.status(400).send('Invalid order status');
        }

        const titles = Array.isArray(req.body.title)
            ? req.body.title
            : [req.body.title];

        const prices = Array.isArray(req.body.price)
            ? req.body.price
            : [req.body.price];

        const quantities = Array.isArray(req.body.quantity)
            ? req.body.quantity
            : [req.body.quantity];

        const ids = Array.isArray(req.body.bookId)
            ? req.body.bookId
            : [req.body.bookId];

        const updatedItems = [];

        for (let i = 0; i < titles.length; i++) {
            const title = String(titles[i] || '').trim();
            const price = Number(prices[i]);
            const quantity = Number.parseInt(quantities[i], 10);

            if (
                !title ||
                !Number.isFinite(price) ||
                price < 0 ||
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 99
            ) {
                return res.status(400).send(
                    'Please enter valid item names, prices and quantities'
                );
            }

            const item = {
                title,
                price,
                quantity
            };

            if (ids[i] && mongoose.isValidObjectId(ids[i])) {
                item.bookId = new mongoose.Types.ObjectId(ids[i]);
            }

            updatedItems.push(item);
        }

        if (!updatedItems.length) {
            return res.status(400).send('Order must contain at least one item');
        }

        order.items = updatedItems;

        order.total = calculateOrderTotal(updatedItems);

        order.status = status;

        order.shipping = {
            name: name.trim(),
            phone: phone.trim(),
            address: address.trim(),
            city: city.trim(),
            postalCode: postalCode.trim()
        };

        await order.save();

        res.redirect('/admin/orders');
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to update order');
    }
});

/* ADMIN: DELETE ORDER */

app.post('/admin/orders/:id/delete', isAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).send('Invalid order ID');
        }

        const order = await Order.findByIdAndDelete(req.params.id);

        if (!order) {
            return res.status(404).send('Order not found');
        }

        res.redirect('/admin/orders');
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to delete order');
    }
});

/* BOOKS */

app.get('/books', async (req, res) => {
    try {
        const books = await Book.find();

        res.render('books.ejs', {
            books,
            isAdmin: !!req.session.isAdmin
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load books');
    }
});

app.get('/books/new', isAdmin, (req, res) => {
    res.render('newbook.ejs');
});

app.post('/books', isAdmin, upload.single('img'), async (req, res) => {
    try {
        await Book.create({
            title: req.body.title,
            author: req.body.author,
            price: Number(req.body.price),
            category: req.body.category,
            image: req.file ? '/uploads/' + req.file.filename : ''
        });

        res.redirect('/books');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error adding book');
    }
});

app.post('/books/delete/:id', isAdmin, async (req, res) => {
    try {
        await Book.findByIdAndDelete(req.params.id);
        res.redirect('/books');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error deleting book');
    }
});

app.get('/books/edit/:id', isAdmin, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.status(404).send('Book not found');
        }

        res.render('editbook.ejs', { book });
    } catch (error) {
        res.status(400).send('Invalid book ID');
    }
});

app.post('/books/edit/:id', isAdmin, upload.single('img'), async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.status(404).send('Book not found');
        }

        book.title = req.body.title;
        book.author = req.body.author;
        book.price = Number(req.body.price);
        book.category = req.body.category;

        if (req.file) {
            book.image = '/uploads/' + req.file.filename;
        }

        await book.save();

        res.redirect('/books');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating book');
    }
});

/* CATEGORIES */

app.get('/categories', async (req, res) => {
    try {
        const books = await Book.find();

        const categories = [
            ...new Set(books.map(book => book.category).filter(Boolean))
        ];

        res.render('categories.ejs', {
            books,
            categories,
            isAdmin: !!req.session.isAdmin
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load categories');
    }
});

app.get('/categories/:category', async (req, res) => {
    try {
        const books = await Book.find({
            category: req.params.category
        });

        const allBooks = await Book.find();

        const categories = [
            ...new Set(allBooks.map(book => book.category).filter(Boolean))
        ];

        res.render('categories.ejs', {
            books,
            categories,
            isAdmin: !!req.session.isAdmin
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load category');
    }
});

/* CART: ADMIN CANNOT SHOP */

app.get('/cart', async (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    try {
        const items = await getCartItems(req);

        const total = items.reduce(
            (sum, item) => sum + item.lineTotal,
            0
        );

        res.render('cart.ejs', {
            items,
            total,
            justAdded: req.query.added === '1',
            attemptedEmptyCheckout: false,
            removedUnavailable: false
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load cart');
    }
});

app.post('/cart/add/:id', async (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.status(404).send('Book not found');
        }

        const cart = getCart(req);
        const id = book._id.toString();

        cart[id] = (Number(cart[id]) || 0) + 1;

        req.session.save(error => {
            if (error) {
                return res.status(500).send('Unable to update cart');
            }

            res.redirect('/cart?added=1');
        });
    } catch (error) {
        console.error(error);
        res.status(400).send('Unable to add book to cart');
    }
});

app.post('/cart/update/:id', (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    const quantity = Number.parseInt(req.body.quantity, 10);
    const cart = getCart(req);
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
        return res.status(400).send('Invalid book ID');
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
        delete cart[id];
    } else {
        cart[id] = Math.min(quantity, 99);
    }

    res.redirect('/cart');
});

app.post('/cart/remove/:id', (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    delete getCart(req)[req.params.id];

    res.redirect('/cart');
});

/* CHECKOUT: CASH ON DELIVERY */

app.get('/checkout', async (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    try {
        const items = await getCartItems(req);

        if (!items.length) {
            return res.redirect('/cart');
        }

        const total = items.reduce(
            (sum, item) => sum + item.lineTotal,
            0
        );

        res.render('checkout.ejs', {
            items,
            total,
            currentUser: req.session.currentUser || { name: '' }
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to open checkout');
    }
});

app.post('/checkout', async (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    try {
        const items = await getCartItems(req);

        if (!items.length) {
            return res.redirect('/cart');
        }

        const {
            name,
            phone,
            address,
            city,
            postalCode
        } = req.body;

        if (
            ![name, phone, address, city, postalCode]
                .every(value => typeof value === 'string' && value.trim())
        ) {
            return res.status(400).send('Please fill in all delivery details');
        }

        const total = items.reduce(
            (sum, item) => sum + item.lineTotal,
            0
        );

        const order = await Order.create({
            items: items.map(item => ({
                bookId: item.book._id,
                title: item.book.title,
                price: Number(item.book.price),
                quantity: item.quantity
            })),
            total,
            status: 'Confirmed',
            shipping: {
                name: name.trim(),
                phone: phone.trim(),
                address: address.trim(),
                city: city.trim(),
                postalCode: postalCode.trim()
            },
            sessionId: req.sessionID
        });

        if (transport) {
            try {
                await transport.sendMail({
                    from: process.env.GMAIL_USER,
                    to: process.env.GMAIL_USER,
                    subject: `New Book Store Order - ${order._id}`,
                    text: `New order received!
Order ID: ${order._id}
Customer: ${order.shipping.name}
Phone: ${order.shipping.phone}
Address: ${order.shipping.address}, ${order.shipping.city} ${order.shipping.postalCode}
Items:
${order.items.map(item => `${item.title} x ${item.quantity} = ₹${item.price * item.quantity}`).join('\n')}
Total: ₹${order.total}
Payment: Cash on Delivery
Status: ${order.status}`
                });
            } catch (emailError) {
                console.error('Order email failed:', emailError.message);
            }
        }

        req.session.cart = {};

        req.session.orderIds = [
            ...(req.session.orderIds || []),
            order._id.toString()
        ];

        req.session.save(error => {
            if (error) {
                return res.status(500).send(
                    'Order saved, but session could not be updated'
                );
            }

            res.redirect('/orders/' + order._id);
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to place order');
    }
});

/* CUSTOMER ORDERS */

app.get('/orders', async (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin/orders');
    }

    try {
        const ids = req.session.orderIds || [];

        const orders = await Order.find({
            _id: { $in: ids },
            sessionId: req.sessionID
        }).sort({ createdAt: -1 });

        res.render('orders.ejs', { orders });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load orders');
    }
});

/* ORDER DETAILS AND BILL */

app.get('/orders/:id', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).send('Order not found');
        }

        const query = req.session.isAdmin
            ? { _id: req.params.id }
            : {
                _id: req.params.id,
                sessionId: req.sessionID
            };

        const order = await Order.findOne(query);

        if (!order) {
            return res.status(404).send('Order not found');
        }

        res.render('order.ejs', {
            order,
            isAdmin: !!req.session.isAdmin
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load order details');
    }
});

/* CONTACT FORM */

app.post('/contact', async (req, res) => {
    try {
        if (!transport) {
            return res.status(500).send(
                'Email is not configured. Set Gmail credentials in .env'
            );
        }

        const {
            name,
            email,
            mobile,
            message
        } = req.body;

        await transport.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            replyTo: email,
            subject: 'New message from The Book Store',
            text: `Name: ${name}
Email: ${email}
Mobile: ${mobile}
Message: ${message}`
        });

        res.send(
            '<script>alert("Message sent successfully");window.location.href="/contact";</script>'
        );
    } catch (error) {
        console.error(error);
        res.status(500).send('Email not sent');
    }
});

/* ERROR HANDLER */

app.use((error, req, res, next) => {
    console.error('FULL ERROR:', error);

    if (
        error instanceof multer.MulterError ||
        error.message === 'Only image files are allowed'
    ) {
        return res.status(400).send(error.message);
    }

    res.status(500).send('Something went wrong. Check the terminal.');
});

/* START SERVER */

async function startServer() {
    try {
        await mongoose.connect(
            process.env.MONGO_URI || 'mongodb://naman:YRiZNLg1lQtXwRNJ@ac-1auwcfj-shard-00-00.juf9uwh.mongodb.net:27017,ac-1auwcfj-shard-00-01.juf9uwh.mongodb.net:27017,ac-1auwcfj-shard-00-02.juf9uwh.mongodb.net:27017/?ssl=true&replicaSet=atlas-qwdgwq-shard-0&authSource=admin&appName=Cluster0');

        console.log('Connected to MongoDB');

        app.listen(port, () => {
            console.log(`Book Store running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('MongoDB connection failed:', error);
        process.exit(1);
    }
}

startServer();
