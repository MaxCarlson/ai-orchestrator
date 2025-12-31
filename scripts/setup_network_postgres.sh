#!/bin/bash
# Setup PostgreSQL for Multi-Device Network Access
# Run on xeres (192.168.50.100)

set -euo pipefail

echo "═══════════════════════════════════════════════════"
echo "PostgreSQL Multi-Device Network Setup"
echo "═══════════════════════════════════════════════════"
echo ""

# Check if running on xeres
if [[ "$(hostname)" != "xeres" ]]; then
    echo "⚠️  Warning: This script should be run on xeres (192.168.50.100)"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if PostgreSQL is running
if ! systemctl is-active --quiet postgresql; then
    echo "❌ PostgreSQL is not running"
    echo "Starting PostgreSQL..."
    sudo systemctl start postgresql
fi

echo "✅ PostgreSQL is running"
echo ""

# Backup existing config
echo "📦 Backing up PostgreSQL configuration..."
sudo cp /etc/postgresql/16/main/postgresql.conf /etc/postgresql/16/main/postgresql.conf.backup.$(date +%Y%m%d)
sudo cp /etc/postgresql/16/main/pg_hba.conf /etc/postgresql/16/main/pg_hba.conf.backup.$(date +%Y%m%d)
echo "✅ Backups created"
echo ""

# Configure postgresql.conf for network access
echo "⚙️  Configuring postgresql.conf for network access..."
sudo sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/16/main/postgresql.conf
sudo sed -i "s/listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/16/main/postgresql.conf
echo "✅ Listen addresses set to '*' (all interfaces)"
echo ""

# Configure pg_hba.conf for LAN access
echo "⚙️  Configuring pg_hba.conf for LAN access..."
if ! grep -q "192.168.50.0/24" /etc/postgresql/16/main/pg_hba.conf; then
    sudo tee -a /etc/postgresql/16/main/pg_hba.conf > /dev/null <<EOF

# Multi-device LAN access (added by setup script)
# Allow connections from 192.168.50.x network
host    knowledge_manager    km_user    192.168.50.0/24    scram-sha-256
host    all                  all        192.168.50.0/24    scram-sha-256
EOF
    echo "✅ LAN access rules added"
else
    echo "✅ LAN access rules already present"
fi
echo ""

# Restart PostgreSQL
echo "🔄 Restarting PostgreSQL..."
sudo systemctl restart postgresql
sleep 2

if systemctl is-active --quiet postgresql; then
    echo "✅ PostgreSQL restarted successfully"
else
    echo "❌ PostgreSQL failed to restart - check logs"
    sudo journalctl -u postgresql -n 50 --no-pager
    exit 1
fi
echo ""

# Configure firewall
echo "🔥 Configuring firewall..."
if command -v ufw &> /dev/null; then
    # Ubuntu/Debian firewall
    sudo ufw allow from 192.168.50.0/24 to any port 5432 comment 'PostgreSQL LAN access'
    echo "✅ UFW rule added for PostgreSQL"
elif command -v firewall-cmd &> /dev/null; then
    # CentOS/RHEL firewall
    sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.50.0/24" port port="5432" protocol="tcp" accept'
    sudo firewall-cmd --reload
    echo "✅ Firewall rule added for PostgreSQL"
else
    echo "⚠️  No firewall detected - you may need to configure manually"
fi
echo ""

# Apply device tracking schema
echo "📊 Applying device tracking schema..."
if [[ -f "../docker/postgres/init-scripts/02_device_tracking.sql" ]]; then
    sudo -u postgres psql -d knowledge_manager -f ../docker/postgres/init-scripts/02_device_tracking.sql
    echo "✅ Device tracking schema applied"
else
    echo "⚠️  Schema file not found - skipping"
fi
echo ""

# Test connection
echo "🧪 Testing network connection..."
echo "   From this machine:"
if psql -h 192.168.50.100 -U km_user -d knowledge_manager -c "SELECT version();" > /dev/null 2>&1; then
    echo "   ✅ Local network connection successful"
else
    echo "   ⚠️  Local connection failed - check password"
fi
echo ""

# Get local IP
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo "═══════════════════════════════════════════════════"
echo "✅ Setup Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "PostgreSQL is now accessible from:"
echo "  - Host: 192.168.50.100 (or $LOCAL_IP)"
echo "  - Port: 5432"
echo "  - Database: knowledge_manager"
echo "  - User: km_user"
echo ""
echo "Next steps for OTHER devices:"
echo ""
echo "1. Set environment variables:"
echo "   export KM_DB_TYPE=postgresql"
echo "   export KM_POSTGRES_HOST=192.168.50.100"
echo "   export KM_POSTGRES_PORT=5432"
echo "   export KM_POSTGRES_DB=knowledge_manager"
echo "   export KM_POSTGRES_USER=km_user"
echo "   export KM_POSTGRES_PASSWORD=<your_password>"
echo ""
echo "2. Test connection:"
echo "   psql -h 192.168.50.100 -U km_user -d knowledge_manager"
echo ""
echo "3. Pull latest code and restart kmtui"
echo ""
echo "See docs/MULTI_DEVICE_SETUP.md for full guide"
echo "═══════════════════════════════════════════════════"
