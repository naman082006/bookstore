
const path = require('path');
require('dotenv').config({
    path: path.join(__dirname, '.env')
});

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const nodemailer = require('nodemailer');
const session = require('express-session');
const fs = require('fs');


const app = express();
const port = 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

fs.mkdirSync(path.join(__dirname, 'public/uploads'), { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
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
    total: Number,
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

const transport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    })
    : null;

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

        if (!book || quantity < 1) {
            delete cart[id];
            continue;
        }

        items.push({
            book,
            quantity,
            lineTotal: Number(book.price) * quantity
        });
    }

    return items;
}

async function getCartTotal(req) {
    const items = await getCartItems(req);
    return items.reduce((sum, item) => sum + item.lineTotal, 0);
}

app.get('/', (req, res) => {
    res.render('home.ejs');
});

app.get('/about', (req, res) => {
    res.render('about.ejs');
});

/* ADMIN */

app.get('/admin/login', (req, res) => {
    res.render('adminlogin.ejs');
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return req.session.save(() => res.redirect('/books'));
    }

    res.status(401).send('Invalid Username or Password');
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
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
        const categories = [...new Set(
            books.map(book => book.category).filter(Boolean)
        )];

        res.render('categories.ejs', { books, categories });
    } catch (error) {
        res.status(500).send('Unable to load categories');
    }
});

app.get('/categories/:category', async (req, res) => {
    try {
        const category = req.params.category;
        const books = await Book.find({ category });
        const allBooks = await Book.find();

        const categories = [...new Set(
            allBooks.map(book => book.category).filter(Boolean)
        )];

        res.render('categories.ejs', { books, categories });
    } catch (error) {
        res.status(500).send('Unable to load category');
    }
});

/* CART */

app.get('/cart', async (req, res) => {
    try {
        const items = await getCartItems(req);
        const total = items.reduce((sum, item) => sum + item.lineTotal, 0);

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
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.status(404).send('Book not found');
        }

        const cart = getCart(req);
        cart[book._id.toString()] = (cart[book._id.toString()] || 0) + 1;

        res.redirect('/cart?added=1');
    } catch (error) {
        res.status(400).send('Unable to add book to cart');
    }
});

app.post('/cart/update/:id', async (req, res) => {
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
    delete getCart(req)[req.params.id];
    res.redirect('/cart');
});

/* CHECKOUT - CASH ON DELIVERY */

app.get('/checkout', async (req, res) => {
    try {
        const items = await getCartItems(req);

        if (!items.length) {
            return res.redirect('/cart');
        }

        const total = items.reduce((sum, item) => sum + item.lineTotal, 0);

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
    try {
        const items = await getCartItems(req);

        if (!items.length) {
            return res.redirect('/cart');
        }

        const { name, phone, address, city, postalCode } = req.body;

        if (![name, phone, address, city, postalCode].every(
            value => typeof value === 'string' && value.trim()
        )) {
            return res.status(400).send('Please fill in all delivery details');
        }

        const total = items.reduce((sum, item) => sum + item.lineTotal, 0);

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
            text: `
New order received!

Order ID: ${order._id}

Customer Name: ${order.shipping.name}
Phone: ${order.shipping.phone}
Address: ${order.shipping.address}
City: ${order.shipping.city}
PIN Code: ${order.shipping.postalCode}

Order Items:
${order.items.map(item =>
    `${item.title} x ${item.quantity} = ₹${item.price * item.quantity}`
).join('\n')}

Total Amount: ₹${order.total}
Payment: Cash on Delivery
Status: ${order.status}
            `
        });

        console.log('Order email sent successfully');
    } catch (emailError) {
        console.error('Order email failed:', emailError.message);
    }
}


        req.session.cart = {};

        const orderIds = req.session.orderIds || [];
        orderIds.push(order._id.toString());
        req.session.orderIds = orderIds;

        req.session.save(error => {
            if (error) {
                console.error(error);
                return res.status(500).send('Order saved, but session could not be updated');
            }

            res.redirect('/orders/' + order._id);
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to place order');
    }
});

/* MY ORDERS */

app.get('/orders', async (req, res) => {
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

/* ORDER DETAILS */

app.get('/orders/:id', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).send('Order not found');
        }

        const order = await Order.findOne({
            _id: req.params.id,
            sessionId: req.sessionID
        });

        if (!order) {
            return res.status(404).send('Order not found');
        }

        res.render('order.ejs', { order });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load order details');
    }
});

/* CONTACT */

app.get('/contact', (req, res) => {
    res.render('contact.ejs');
});

app.post('/contact', async (req, res) => {
    try {
        if (!transport) {
            return res.status(500).send('Email is not configured. Set Gmail credentials in .env');
        }

        const { name, email, mobile, message } = req.body;

        await transport.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            replyTo: email,
            subject: 'New message from The Book Store',
            text: `Name: ${name}\nEmail: ${email}\nMobile: ${mobile}\nMessage: ${message}`
        });

        res.send(`
            <script>
                alert("Message sent successfully");
                window.location.href = "/contact";
            </script>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send('Email not sent');
    }
});

/* ERROR HANDLER */

app.use((error, req, res, next) => {
    console.error('FULL ERROR:', error);

    if (error instanceof multer.MulterError || error.message === 'Only image files are allowed') {
        return res.status(400).send(error.message);
    }

    res.status(500).send('Something went wrong. Check the terminal.');
});


/* START SERVER */

async function startServer() {
    try {
        await mongoose.connect(
            process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bookstore'
        );

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