const express = require('express');
const mongoose = require('mongoose');
const AWS = require('aws-sdk');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');

dotenv.config();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error(err));

// AWS S3 Configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
    region: "eu-north-1"
});

// User Schema
const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    secondName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    profilePicture: { type: String, default: '' }
});
const userModel = mongoose.model('User', userSchema);

// Admin Schema
const adminSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    secondName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    profilePicture: { type: String, default: '' }
});
const adminModel = mongoose.model('Admin', adminSchema);

// Image Schema
const imageSchema = new mongoose.Schema({
    url: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, default: '' }
});
const Image = mongoose.model('Image', imageSchema);

const orderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    products: [{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Image', required: true },
        quantity: { type: Number, required: true, min: 1 }
    }],
    name: { type: String, required: true },
    address: { type: String, required: true },
    paymentType: { type: String, required: true },
    amount: { type: Number, required: true },
    paymentStatus: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// Upload Image to S3
app.post('/upload', async (req, res) => {
    try {
        const { image, name, price, description } = req.body;
        if (!image || !name || price === undefined) {
            return res.status(400).json({ error: 'Image, name, and price are required' });
        }

        const parsedPrice = parseFloat(price);
        if (isNaN(parsedPrice) || parsedPrice < 0) {
            return res.status(400).json({ error: 'Price must be a positive number' });
        }

        const base64Data = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const type = image.split(';')[0].split('/')[1];
        const fileSize = base64Data.length / 1024 / 1024;
        if (fileSize > 5) {
            return res.status(413).json({ error: 'Image size exceeds 5MB limit' });
        }

        const params = {
            Bucket: process.env.AWS_BUCKET,
            Key: `${Date.now()}.${type}`,
            Body: base64Data,
            ContentType: `image/${type}`,
            ACL: 'public-read'
        };

        const { Location } = await s3.upload(params).promise();
        const newImage = new Image({
            url: Location,
            name,
            price: parsedPrice,
            description: description || ''
        });
        await newImage.save();

        res.json({ url: Location });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});

// Fetch All Images
app.get('/images', async (req, res) => {
    try {
        const images = await Image.find();
        res.json(images);
    } catch (err) {
        console.error('Fetch error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

// Fetch Images by IDs
app.post('/cart-items', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids)) {
            return res.status(400).json({ error: 'IDs must be an array' });
        }
        const images = await Image.find({ _id: { $in: ids } });
        res.json(images);
    } catch (err) {
        console.error('Fetch cart items error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

// Delete Image
app.delete('/delete-image/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid image ID' });
        }

        const image = await Image.findById(id);
        if (!image) {
            return res.status(404).json({ error: 'Image not found' });
        }

        const key = image.url.split('/').pop();
        const params = {
            Bucket: process.env.AWS_BUCKET,
            Key: key
        };

        try {
            await s3.deleteObject(params).promise();
        } catch (s3Err) {
            console.error('S3 delete error:', s3Err);
        }

        await Image.findByIdAndDelete(id);
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ error: 'Delete failed', details: err.message });
    }
});

// Create Admin
app.post('/create-admins', async (req, res) => {
    try {
        const { firstName, secondName, email, password, profilePicture } = req.body;
        if (!firstName || !secondName || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const existingAdmin = await adminModel.findOne({ email });
        if (existingAdmin) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        let profilePicData = '';
        if (profilePicture) {
            if (!profilePicture.startsWith('data:image/')) {
                return res.status(400).json({ error: 'Invalid base64 image format' });
            }
            const base64Data = profilePicture.replace(/^data:image\/\w+;base64,/, '');
            const type = profilePicture.split(';')[0].split('/')[1];
            if (!['jpeg', 'jpg', 'png'].includes(type)) {
                return res.status(400).json({ error: 'Invalid image format. Use JPEG or PNG' });
            }
            const fileSize = Buffer.from(base64Data, 'base64').length / 1024 / 1024;
            if (fileSize > 1) {
                return res.status(413).json({ error: 'Profile picture size exceeds 1MB limit' });
            }
            profilePicData = profilePicture;
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const admin = await adminModel.create({
            firstName,
            secondName,
            email,
            password: hashedPassword,
            profilePicture: profilePicData
        });

        res.status(201).json({ message: 'Admin registered successfully', admin: { firstName, email, profilePicture: profilePicData } });
    } catch (err) {
        console.error('Create admin error:', err);
        res.status(500).json({ error: 'Registration failed', details: err.message });
    }
});

// Admin Login
app.post('/admin-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const admin = await adminModel.findOne({ email });
        if (!admin) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        res.json({ 
            message: 'Login successful', 
            admin: { 
                firstName: admin.firstName, 
                email: admin.email, 
                profilePicture: admin.profilePicture 
            } 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed', details: err.message });
    }
});

// Admin Profile
app.get('/admin/profile', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const admin = await adminModel.findOne({ email }, '-password');
        if (!admin) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        res.json({ admin });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: 'Failed to fetch profile', details: err.message });
    }
});

// Get All Admins
app.get('/admin/admins', async (req, res) => {
    try {
        const admins = await adminModel.find({}, '-password');
        res.json(admins);
    } catch (err) {
        console.error('Get admins error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

// Create User
app.post('/create-users', async (req, res) => {
    try {
        const { firstName, secondName, email, password, profilePicture } = req.body;
        if (!firstName || !secondName || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const existingUser = await userModel.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        let profilePicData = '';
        if (profilePicture) {
            if (!profilePicture.startsWith('data:image/')) {
                return res.status(400).json({ error: 'Invalid base64 image format' });
            }
            const base64Data = profilePicture.replace(/^data:image\/\w+;base64,/, '');
            const type = profilePicture.split(';')[0].split('/')[1];
            if (!['jpeg', 'jpg', 'png'].includes(type)) {
                return res.status(400).json({ error: 'Invalid image format. Use JPEG or PNG' });
            }
            const fileSize = Buffer.from(base64Data, 'base64').length / 1024 / 1024;
            if (fileSize > 1) {
                return res.status(413).json({ error: 'Profile picture size exceeds 1MB limit' });
            }
            profilePicData = profilePicture;
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const user = await userModel.create({
            firstName,
            secondName,
            email,
            password: hashedPassword,
            profilePicture: profilePicData
        });

        res.status(201).json({ message: 'User registered successfully', user: { firstName, email, profilePicture: profilePicData } });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Registration failed', details: err.message });
    }
});

// User Login
app.post('/user-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await userModel.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        res.json({ 
            message: 'Login successful', 
            user: { 
                _id: user._id,
                firstName: user.firstName, 
                secondName: user.secondName,
                email: user.email, 
                profilePicture: user.profilePicture 
            } 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed', details: err.message });
    }
});

// Create Order
app.post('/create-order', async (req, res) => {
    try {
        const { userId, products, name, address, paymentType, amount } = req.body;
        if (!userId || !products || !name || !address || !paymentType || !amount) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        for (const item of products) {
            if (!mongoose.Types.ObjectId.isValid(item.productId)) {
                return res.status(400).json({ error: `Invalid product ID: ${item.productId}` });
            }
            if (!Number.isInteger(item.quantity) || item.quantity < 1) {
                return res.status(400).json({ error: `Invalid quantity for product ${item.productId}` });
            }
        }

        const user = await userModel.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const productIds = products.map(p => p.productId);
        const foundProducts = await Image.find({ _id: { $in: productIds } });
        if (foundProducts.length !== productIds.length) {
            return res.status(404).json({ error: 'One or more products not found' });
        }

        const order = await Order.create({
            userId,
            products,
            name,
            address,
            paymentType,
            amount
        });

        res.status(201).json({ order });
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: 'Order creation failed', details: err.message });
    }
});

// Get All Orders
app.get('/orders', async (req, res) => {
    try {
        const orders = await Order.find()
            .populate('userId', 'firstName secondName email')
            .populate('products.productId', 'name price');
        res.json(orders);
    } catch (err) {
        console.error('Fetch orders error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

// Get Order by ID
app.get('/order/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid order ID' });
        }

        const order = await Order.findById(id).populate('products.productId');
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ order });
    } catch (err) {
        console.error('Fetch order error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

// Get All Users
app.get('/admin/users', async (req, res) => {
    try {
        const users = await userModel.find({}, '-password');
        res.json(users);
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));